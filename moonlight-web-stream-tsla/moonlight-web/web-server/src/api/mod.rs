use actix_web::{
    Either, Error, HttpResponse, Responder, delete,
    dev::HttpServiceFactory,
    get, middleware, post, put, services,
    web::{self, Bytes, Data, Json, Query},
};
use futures::future::join_all;
use log::{info, warn};
use moonlight_common::{
    PairPin, PairStatus,
    high::{HostError, broadcast_magic_packet},
    network::{
        ApiError,
        reqwest::{ReqwestError, ReqwestMoonlightHost},
    },
    pair::generate_new_client,
};
use std::{io::Write as _, path::PathBuf, process::Command, time::Duration};
use tokio::sync::Mutex;

use crate::{
    Config,
    api::auth::{auth_middleware, post_auth_login, get_auth_info, get_totp_setup, post_totp_enable, delete_totp},
    data::{HostCache, RuntimeApiData, RuntimeApiHost},
};
use common::api_bindings::{
    DeleteHostQuery, DetailedHost, GetAppImageQuery, GetAppsQuery, GetAppsResponse, GetHostQuery,
    GetHostResponse, GetHostsResponse, PostPairRequest, PostPairResponse1, PostPairResponse2,
    PostWakeUpRequest, PutHostRequest, PutHostResponse, UndetailedHost,
};

pub mod auth;
mod stream;

#[get("/authenticate")]
async fn authenticate() -> impl Responder {
    HttpResponse::Ok()
}

#[get("/hosts")]
async fn list_hosts(data: Data<RuntimeApiData>) -> Either<Json<GetHostsResponse>, HttpResponse> {
    let hosts = data.hosts.read().await;

    let hosts = join_all(hosts.iter().map(|(host_id, host)| async move {
        let mut host = host.lock().await;
        let mut name = host.cache.name.clone();

        into_undetailed_host(
            host_id,
            || name.take().unwrap_or_else(|| String::from("offline")),
            &mut host.moonlight,
        )
        .await
    }))
    .await;

    Either::Left(Json(GetHostsResponse { hosts }))
}

#[get("/host")]
async fn get_host(
    data: Data<RuntimeApiData>,
    Query(query): Query<GetHostQuery>,
) -> Either<Json<GetHostResponse>, HttpResponse> {
    let hosts = data.hosts.read().await;

    let host_id = query.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };

    let mut host = host.lock().await;

    if query.force_refresh {
        host.moonlight.clear_cache();
    }

    host.try_recache(&data).await;

    let Ok(detailed_host) = into_detailed_host(host_id as usize, &mut host.moonlight).await else {
        return Either::Right(HttpResponse::InternalServerError().finish());
    };

    Either::Left(Json(GetHostResponse {
        host: detailed_host,
    }))
}

#[put("/host")]
async fn put_host(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    Json(query): Json<PutHostRequest>,
) -> Either<Json<PutHostResponse>, HttpResponse> {
    // Create and Try to connect to host
    let mut host = match ReqwestMoonlightHost::new(
        query.address,
        query
            .http_port
            .unwrap_or(config.moonlight_default_http_port),
        None,
    ) {
        Ok(value) => value,
        Err(err) => {
            warn!("[Api] failed to create new moonlight host: {err:?}");
            return Either::Right(HttpResponse::InternalServerError().finish());
        }
    };

    let mac = match host.mac().await {
        Ok(value) => value,
        Err(HostError::Api(ApiError::RequestClient(ReqwestError::Reqwest(err))))
            if err.is_timeout() =>
        {
            return Either::Right(HttpResponse::NotFound().finish());
        }
        Err(HostError::Api(ApiError::RequestClient(ReqwestError::Reqwest(err))))
            if err.is_connect() =>
        {
            return Either::Right(HttpResponse::NotFound().finish());
        }
        Err(_) => return Either::Right(HttpResponse::BadRequest().finish()),
    };
    let Ok(name) = host.host_name().await else {
        return Either::Right(HttpResponse::InternalServerError().finish());
    };

    // Write host
    let mut hosts = data.hosts.write().await;

    let host_id = hosts.vacant_key();
    hosts.insert(Mutex::new(RuntimeApiHost {
        cache: HostCache {
            name: Some(name.to_string()),
            mac,
        },
        moonlight: host,
        app_images_cache: Default::default(),
        active_stream: tokio::sync::watch::channel(None).0,
        stream_lifecycle: std::sync::Arc::new(tokio::sync::Mutex::new(())),
    }));

    drop(hosts);

    // Read host and respond
    let hosts = data.hosts.read().await;
    let Some(host) = hosts.get(host_id) else {
        return Either::Right(HttpResponse::InternalServerError().finish());
    };
    let mut host = host.lock().await;

    data.request_save();

    let Ok(detailed_host) = into_detailed_host(host_id, &mut host.moonlight).await else {
        return Either::Right(HttpResponse::InternalServerError().finish());
    };

    Either::Left(Json(PutHostResponse {
        host: detailed_host,
    }))
}

#[delete("/host")]
async fn delete_host(
    data: Data<RuntimeApiData>,
    Query(query): Query<DeleteHostQuery>,
) -> HttpResponse {
    let mut hosts = data.hosts.write().await;

    let host = hosts.try_remove(query.host_id as usize);

    drop(hosts);

    if host.is_none() {
        return HttpResponse::NotFound().finish();
    } else {
        data.request_save();
    }

    HttpResponse::Ok().finish()
}

#[post("/pair")]
async fn pair_host(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    Json(request): Json<PostPairRequest>,
) -> HttpResponse {
    let hosts = data.hosts.read().await;

    let host_id = request.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return HttpResponse::NotFound().finish();
    };

    let host = host.lock().await;

    if matches!(host.moonlight.is_paired(), PairStatus::Paired) {
        return HttpResponse::NotModified().finish();
    }

    let data = data.clone();

    let stream = async_stream::stream! {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            let Ok(text) = serde_json::to_string(&PostPairResponse1::InternalServerError) else {
                unreachable!()
            };

            let bytes = Bytes::from_owner(text);
            yield Ok::<_, Error>(bytes);

            return;
        };
        let mut host = host.lock().await;

        let Ok(client_auth) = generate_new_client() else {
            warn!("[Api]: failed to generate new client to host authentication data");

            let Ok(text) = serde_json::to_string(&PostPairResponse1::InternalServerError) else {
                unreachable!()
            };

            let bytes = Bytes::from_owner(text);
            yield Ok::<_, Error>(bytes);

            return;
        };

        let Ok(pin) = PairPin::generate() else {
            warn!("[Api]: failed to generate pin!");

            return
        };

            let Ok(text) = serde_json::to_string(&PostPairResponse1::Pin(pin.to_string())) else {
                unreachable!()
            };

            let bytes = Bytes::from_owner(text);
            yield Ok::<_, Error>(bytes);

        if let Err(err) = host.moonlight
            .pair(
                &client_auth,
                config.pair_device_name.to_string(),
                pin,
            )
            .await
        {
            info!("[Api]: failed to pair host {}: {:?}", host.moonlight.address(), err);

            let Ok(text) = serde_json::to_string(&PostPairResponse2::PairError) else {
                unreachable!()
            };

            let bytes = Bytes::from_owner(text);
            yield Ok::<_, Error>(bytes);

            return;
        };

        data.request_save();

        let detailed_host = match into_detailed_host(host_id as usize, &mut host.moonlight).await {
            Err(err) => {
                warn!("[Api] failed to get host info after pairing for host {host_id}: {err:?}");

                let Ok(text) = serde_json::to_string(&PostPairResponse2::PairError) else {
                    unreachable!()
                };

                let bytes = Bytes::from_owner(text);
                yield Ok::<_, Error>(bytes);

                return
            }
            Ok(value) => value,
        };

        let mut text = Vec::new();
        let _ = writeln!(&mut text);
        if  serde_json::to_writer(&mut text, &PostPairResponse2::Paired(detailed_host)).is_err() {
            unreachable!()
        };

        drop(host);
        drop(hosts);

        let bytes = Bytes::from_owner(text);
        yield Ok::<_, Error>(bytes);
    };

    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/x-ndjson"))
        .streaming(stream)
}

#[post("/host/wake")]
async fn wake_host(
    data: Data<RuntimeApiData>,
    Json(request): Json<PostWakeUpRequest>,
) -> HttpResponse {
    let hosts = data.hosts.read().await;

    let host_id = request.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return HttpResponse::NotFound().finish();
    };
    let host = host.lock().await;

    let mac = host.cache.mac;

    if let Some(mac) = mac {
        if let Err(err) = broadcast_magic_packet(mac).await {
            warn!("failed to send magic(wake on lan) packet: {err:?}");
            return HttpResponse::InternalServerError().finish();
        }
    } else {
        return HttpResponse::InternalServerError().finish();
    }

    HttpResponse::Ok().finish()
}

#[get("/apps")]
async fn get_apps(
    data: Data<RuntimeApiData>,
    Query(query): Query<GetAppsQuery>,
) -> Either<Json<GetAppsResponse>, HttpResponse> {
    let hosts = data.hosts.read().await;

    let host_id = query.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };
    let mut host = host.lock().await;

    if query.force_refresh {
        host.moonlight.clear_cache();
    }

    let app_list = match host.moonlight.app_list().await {
        Err(err) => {
            warn!("[Api]: failed to get app list for host {host_id}: {err:?}");

            return Either::Right(HttpResponse::InternalServerError().finish());
        }
        Ok(value) => value,
    };

    Either::Left(Json(GetAppsResponse {
        apps: app_list.iter().map(|x| x.to_owned().into()).collect(),
    }))
}

#[get("/app/image")]
async fn get_app_image(
    data: Data<RuntimeApiData>,
    Query(query): Query<GetAppImageQuery>,
) -> Either<Bytes, HttpResponse> {
    let hosts = data.hosts.read().await;

    let host_id = query.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };
    let mut host = host.lock().await;

    if query.force_refresh {
        host.app_images_cache.clear();
        host.moonlight.clear_cache();
    }

    let app_id = query.app_id;
    if let Some(cache) = host.app_images_cache.get(&app_id) {
        return Either::Left(cache.clone());
    }

    let image = host.moonlight.request_app_image(app_id).await;
    match image {
        Err(err) => {
            warn!("[Api]: failed to get host {host_id} app image {app_id}: {err:?}");

            Either::Right(HttpResponse::InternalServerError().finish())
        }
        Ok(image) => {
            host.app_images_cache.insert(app_id, image.clone());

            Either::Left(image)
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum DisplayPreset {
    Driving,
    Fullscreen,
    Native,
}

#[derive(serde::Deserialize)]
struct SetDisplayPresetRequest {
    preset: DisplayPreset,
    width: Option<u32>,
    height: Option<u32>,
}

#[post("/display/preset")]
async fn set_display_preset(Json(request): Json<SetDisplayPresetRequest>) -> HttpResponse {
    let dimensions = match (request.width, request.height) {
        (None, None) => None,
        (Some(w), Some(h)) if (320..=3840).contains(&w) && (240..=2160).contains(&h)
            && w % 2 == 0 && h % 2 == 0 => Some((w, h)),
        _ => return HttpResponse::BadRequest().finish(),
    };
    let preset = match request.preset {
        DisplayPreset::Driving => "driving",
        DisplayPreset::Fullscreen => "fullscreen",
        DisplayPreset::Native => "native",
    };

    let Some(helper) = std::env::var_os("COCKPIT_DISPLAY_HELPER").map(PathBuf::from) else {
        // Ubuntu/Wayland: change the negotiated stream size without changing
        // the physical display. An optional administrator-supplied helper may
        // implement monitor switching; it is never required for streaming.
        return HttpResponse::Ok().json(serde_json::json!({
            "preset": preset, "mode": "stream-only", "display_changed": false
        }));
    };
    if !helper.is_absolute() {
        warn!("[Display] refusing to run a non-absolute display helper path");
        return HttpResponse::InternalServerError().finish();
    }

    let result = web::block(move || {
        let mut command = Command::new(helper);
        command.arg(preset);
        if let Some((width, height)) = dimensions {
            command.arg(width.to_string()).arg(height.to_string());
        }
        command.output()
    }).await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => {
            warn!("[Display] failed to start helper for {preset}: {err}");
            return HttpResponse::InternalServerError().finish();
        }
        Err(err) => {
            warn!("[Display] helper task failed for {preset}: {err}");
            return HttpResponse::InternalServerError().finish();
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("[Display] helper rejected {preset}: {}", stderr.trim());
        return HttpResponse::Conflict().finish();
    }

    let mode = String::from_utf8_lossy(&output.stdout).trim().to_string();
    info!("[Display] applied {preset}: {mode}");
    HttpResponse::Ok().json(serde_json::json!({ "preset": preset, "mode": mode }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum YoutubeControlAction {
    Home,
    Back,
    Search,
    Top,
    ScrollUp,
    ScrollDown,
    FocusUp,
    FocusDown,
    FocusLeft,
    FocusRight,
    Select,
    PlayPause,
    SeekBack,
    SeekForward,
    Previous,
    Next,
    VolumeDown,
    VolumeUp,
    Mute,
    Captions,
    Fullscreen,
    Layout,
    Exit,
}

#[derive(serde::Deserialize)]
struct YoutubeControlRequest {
    action: YoutubeControlAction,
    query: Option<String>,
}

#[post("/youtube/control")]
async fn youtube_control(Json(request): Json<YoutubeControlRequest>) -> HttpResponse {
    let action = match request.action {
        YoutubeControlAction::Home => "home",
        YoutubeControlAction::Back => "back",
        YoutubeControlAction::Search => "search",
        YoutubeControlAction::Top => "top",
        YoutubeControlAction::ScrollUp => "scroll_up",
        YoutubeControlAction::ScrollDown => "scroll_down",
        YoutubeControlAction::FocusUp => "focus_up",
        YoutubeControlAction::FocusDown => "focus_down",
        YoutubeControlAction::FocusLeft => "focus_left",
        YoutubeControlAction::FocusRight => "focus_right",
        YoutubeControlAction::Select => "select",
        YoutubeControlAction::PlayPause => "play_pause",
        YoutubeControlAction::SeekBack => "seek_back",
        YoutubeControlAction::SeekForward => "seek_forward",
        YoutubeControlAction::Previous => "previous",
        YoutubeControlAction::Next => "next",
        YoutubeControlAction::VolumeDown => "volume_down",
        YoutubeControlAction::VolumeUp => "volume_up",
        YoutubeControlAction::Mute => "mute",
        YoutubeControlAction::Captions => "captions",
        YoutubeControlAction::Fullscreen => "fullscreen",
        YoutubeControlAction::Layout => "layout",
        YoutubeControlAction::Exit => "exit",
    };

    let query = request.query.unwrap_or_default();
    if query.chars().count() > 200 {
        return HttpResponse::BadRequest().json(serde_json::json!({ "error": "query_too_long" }));
    }

    let Some(token_path) = std::env::var_os("COCKPIT_YOUTUBE_CONTROL_TOKEN_FILE").map(PathBuf::from) else {
        warn!("[YouTubeControl] token file is not configured");
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "not_configured" }));
    };
    if !token_path.is_absolute() {
        warn!("[YouTubeControl] refusing non-absolute token file path");
        return HttpResponse::InternalServerError().finish();
    }
    let token = match tokio::fs::read_to_string(&token_path).await {
        Ok(token) => token.trim().to_string(),
        Err(_) => {
            return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "youtube_not_running" }));
        }
    };

    let client = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(error) => {
            warn!("[YouTubeControl] failed to build local client: {error}");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let response = client
        .post("http://127.0.0.1:9228/control")
        .header("x-cockpit-control-token", token)
        .json(&serde_json::json!({ "action": action, "query": query }))
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!("[YouTubeControl] {action} failed: {error}");
            return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "youtube_not_running" }));
        }
    };
    if !response.status().is_success() {
        warn!("[YouTubeControl] helper rejected {action}: HTTP {}", response.status());
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "control_failed" }));
    }

    let payload = response.json::<serde_json::Value>().await.unwrap_or_else(|_| {
        serde_json::json!({ "ok": true, "action": action })
    });
    if payload.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        info!("[YouTubeControl] safely ignored {action}: no active player");
    } else {
        info!("[YouTubeControl] applied {action}");
    }
    HttpResponse::Ok().json(payload)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum Ub1818ControlAction {
    Home,
    History,
    Browse,
    Midnight,
    Login,
    Quit,
    Back,
    Top,
    ScrollUp,
    ScrollDown,
    FocusUp,
    FocusDown,
    FocusLeft,
    FocusRight,
    Select,
    PlayPause,
    Fullscreen,
}

#[derive(serde::Deserialize)]
struct Ub1818ControlRequest {
    action: Ub1818ControlAction,
}

#[post("/ub1818/control")]
async fn ub1818_control(Json(request): Json<Ub1818ControlRequest>) -> HttpResponse {
    let action = match request.action {
        Ub1818ControlAction::Home => "home",
        Ub1818ControlAction::History => "history",
        Ub1818ControlAction::Browse => "browse",
        Ub1818ControlAction::Midnight => "midnight",
        Ub1818ControlAction::Login => "login",
        Ub1818ControlAction::Quit => "quit",
        Ub1818ControlAction::Back => "back",
        Ub1818ControlAction::Top => "top",
        Ub1818ControlAction::ScrollUp => "scroll_up",
        Ub1818ControlAction::ScrollDown => "scroll_down",
        Ub1818ControlAction::FocusUp => "focus_up",
        Ub1818ControlAction::FocusDown => "focus_down",
        Ub1818ControlAction::FocusLeft => "focus_left",
        Ub1818ControlAction::FocusRight => "focus_right",
        Ub1818ControlAction::Select => "select",
        Ub1818ControlAction::PlayPause => "play_pause",
        Ub1818ControlAction::Fullscreen => "fullscreen",
    };

    let client = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(error) => {
            warn!("[UB1818Control] failed to build local client: {error}");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let response = client
        .post("http://127.0.0.1:9238/control")
        .json(&serde_json::json!({ "action": action }))
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!("[UB1818Control] {action} failed: {error}");
            return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "ub1818_not_running" }));
        }
    };
    if !response.status().is_success() {
        warn!("[UB1818Control] helper rejected {action}: HTTP {}", response.status());
        return HttpResponse::ServiceUnavailable().json(serde_json::json!({ "error": "control_failed" }));
    }
    let payload = response.json::<serde_json::Value>().await.unwrap_or_else(|_| {
        serde_json::json!({ "ok": true, "action": action })
    });
    info!("[UB1818Control] applied {action}");
    HttpResponse::Ok().json(payload)
}

pub fn api_service(data: Data<RuntimeApiData>) -> impl HttpServiceFactory {
    web::scope("/api")
        .wrap(middleware::from_fn(auth_middleware))
        .app_data(data)
        .service(services![
            authenticate,
            post_auth_login,
            get_auth_info,
            get_totp_setup,
            post_totp_enable,
            delete_totp,
        ])
        .service(services![
            stream::start_host,
            stream::cancel_host,
            list_hosts,
            get_host,
            put_host,
            wake_host,
            delete_host,
            pair_host,
            get_apps,
            get_app_image,
            set_display_preset,
            youtube_control,
        ])
        .service(ub1818_control)
}

async fn into_undetailed_host(
    id: usize,
    name: impl FnOnce() -> String,
    host: &mut ReqwestMoonlightHost,
) -> UndetailedHost {
    let name = host
        .host_name()
        .await
        .map(str::to_string)
        .unwrap_or_else(|_| name());

    let paired = host.is_paired();

    let server_state = host
        .state()
        .await
        .map(|(_, state)| Option::Some(state))
        .unwrap_or(None);

    UndetailedHost {
        host_id: id as u32,
        name,
        paired: paired.into(),
        server_state: server_state.map(Into::into),
    }
}
async fn into_detailed_host(
    id: usize,
    host: &mut ReqwestMoonlightHost,
) -> Result<DetailedHost, HostError<ReqwestError>> {
    Ok(DetailedHost {
        host_id: id as u32,
        name: host.host_name().await?.to_string(),
        paired: host.is_paired().into(),
        server_state: host.state().await?.1.into(),
        address: host.address().to_string(),
        http_port: host.http_port(),
        https_port: host.https_port().await?,
        external_port: host.external_port().await?,
        version: host.version().await?.to_string(),
        gfe_version: host.gfe_version().await?.to_string(),
        unique_id: host.unique_id().await?.to_string(),
        mac: host.mac().await?.map(|mac| mac.to_string()),
        local_ip: host.local_ip().await?.to_string(),
        current_game: host.current_game().await?,
        max_luma_pixels_hevc: host.max_luma_pixels_hevc().await?,
        server_codec_mode_support: host.server_codec_mode_support_raw().await?,
    })
}
