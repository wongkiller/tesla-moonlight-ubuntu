use std::{pin::Pin, sync::Arc, time::Duration};

use bytes::Bytes;
use log::debug;
use openssl::{
    pkey::{PKey, Private},
    ssl::{SslConnector, SslMethod, SslVerifyMode},
    x509::X509,
};
use pem::Pem;
use reqwest::Client;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{error::Elapsed, timeout},
};
use tokio_openssl::SslStream;
use url::{ParseError, Url};

use crate::network::{
    ApiError,
    request_client::{QueryParamsRef, RequestClient},
};

#[cfg(feature = "high")]
pub type ReqwestMoonlightHost = crate::high::MoonlightHost<MoonlightHttpClient>;

#[derive(Debug, Error)]
pub enum ReqwestError {
    #[error("{0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("{0}")]
    UrlParse(#[from] ParseError),
    #[error("{0}")]
    OpenSsl(#[from] openssl::error::ErrorStack),
    #[error("{0}")]
    Tls(#[from] openssl::ssl::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Timeout(#[from] Elapsed),
    #[error("invalid HTTP response from Sunshine")]
    InvalidHttpResponse,
    #[error("Sunshine returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("Sunshine returned non-UTF-8 text")]
    InvalidUtf8(#[from] std::string::FromUtf8Error),
}
pub type ReqwestApiError = ApiError<ReqwestError>;

struct TlsIdentity {
    client_certificate: X509,
    client_private_key: PKey<Private>,
    pinned_server_der: Vec<u8>,
}

/// HTTP client for Moonlight's control protocol.
///
/// Plain HTTP discovery continues to use reqwest. Paired HTTPS requests use
/// OpenSSL directly so the client private key stays in process memory. The
/// macOS native-tls backend imports that key as a temporary Keychain Identity
/// and repeatedly displays a login-keychain password prompt.
pub struct MoonlightHttpClient {
    http: Client,
    tls_identity: Option<Arc<TlsIdentity>>,
    request_timeout: Duration,
}

fn build_plain_client(request_timeout: Duration) -> Result<Client, ReqwestError> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .timeout(request_timeout)
        .pool_max_idle_per_host(0)
        .build()?)
}

fn build_url(
    use_https: bool,
    hostport: &str,
    path: &str,
    query_params: &QueryParamsRef<'_>,
) -> Result<Url, ReqwestError> {
    let protocol = if use_https { "https" } else { "http" };
    let authority = format!("{protocol}://{hostport}/{path}");
    let url = Url::parse_with_params(&authority, query_params)?;
    debug!("Request: {url}");
    Ok(url)
}

fn request_target(path: &str, query_params: &QueryParamsRef<'_>) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in query_params {
        serializer.append_pair(key, value);
    }
    let query = serializer.finish();
    if query.is_empty() {
        format!("/{path}")
    } else {
        format!("/{path}?{query}")
    }
}

fn parse_http_response(response: Vec<u8>) -> Result<Bytes, ReqwestError> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(ReqwestError::InvalidHttpResponse)?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| ReqwestError::InvalidHttpResponse)?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(ReqwestError::InvalidHttpResponse)?;
    if !(200..300).contains(&status) {
        return Err(ReqwestError::HttpStatus(status));
    }
    Ok(Bytes::copy_from_slice(&response[separator + 4..]))
}

impl MoonlightHttpClient {
    async fn send_https_request(
        &self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Bytes, ReqwestError> {
        let identity = self
            .tls_identity
            .as_ref()
            .ok_or(ReqwestError::InvalidHttpResponse)?
            .clone();
        let target = request_target(path, query_params);
        debug!("Request: https://{hostport}{target}");

        timeout(self.request_timeout, async move {
            let tcp = TcpStream::connect(hostport).await?;

            let mut connector = SslConnector::builder(SslMethod::tls_client())?;
            connector.set_certificate(&identity.client_certificate)?;
            connector.set_private_key(&identity.client_private_key)?;
            connector.check_private_key()?;

            let pinned_server_der = identity.pinned_server_der.clone();
            connector.set_verify_callback(SslVerifyMode::PEER, move |_preverified, context| {
                context
                    .current_cert()
                    .and_then(|certificate| certificate.to_der().ok())
                    .is_some_and(|der| der == pinned_server_der)
            });

            let connector = connector.build();
            let mut configuration = connector.configure()?;
            configuration.set_verify_hostname(false);
            let ssl = configuration.into_ssl("sunshine")?;
            let mut stream = SslStream::new(ssl, tcp)?;
            Pin::new(&mut stream).connect().await?;

            let request = format!(
                "GET {target} HTTP/1.1\r\nHost: {hostport}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await?;
            stream.flush().await?;

            let mut response = Vec::new();
            stream.read_to_end(&mut response).await?;
            parse_http_response(response)
        })
        .await?
    }
}

impl RequestClient for MoonlightHttpClient {
    type Error = ReqwestError;
    type Text = String;
    type Bytes = Bytes;

    fn with_defaults_long_timeout() -> Result<Self, Self::Error> {
        let request_timeout = Duration::from_secs(90);
        Ok(Self {
            http: build_plain_client(request_timeout)?,
            tls_identity: None,
            request_timeout,
        })
    }

    fn with_defaults() -> Result<Self, Self::Error> {
        let request_timeout = Duration::from_secs(2);
        Ok(Self {
            http: build_plain_client(request_timeout)?,
            tls_identity: None,
            request_timeout,
        })
    }

    fn with_certificates(
        client_private_key: &Pem,
        client_certificate: &Pem,
        server_certificate: &Pem,
    ) -> Result<Self, Self::Error> {
        Self::with_certificates_and_timeout(
            client_private_key,
            client_certificate,
            server_certificate,
            Duration::from_secs(2),
        )
    }

    fn with_certificates_long_timeout(
        client_private_key: &Pem,
        client_certificate: &Pem,
        server_certificate: &Pem,
    ) -> Result<Self, Self::Error> {
        Self::with_certificates_and_timeout(
            client_private_key,
            client_certificate,
            server_certificate,
            Duration::from_secs(90),
        )
    }

    async fn send_http_request_text_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Text, Self::Error> {
        let url = build_url(false, hostport, path, query_params)?;
        Ok(self.http.get(url).send().await?.text().await?)
    }

    async fn send_https_request_text_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Text, Self::Error> {
        let bytes = self.send_https_request(hostport, path, query_params).await?;
        Ok(String::from_utf8(bytes.to_vec())?)
    }

    async fn send_https_request_data_response(
        &mut self,
        hostport: &str,
        path: &str,
        query_params: &QueryParamsRef<'_>,
    ) -> Result<Self::Bytes, Self::Error> {
        self.send_https_request(hostport, path, query_params).await
    }
}

impl MoonlightHttpClient {
    fn with_certificates_and_timeout(
        client_private_key: &Pem,
        client_certificate: &Pem,
        server_certificate: &Pem,
        request_timeout: Duration,
    ) -> Result<Self, ReqwestError> {
        let tls_identity = TlsIdentity {
            client_certificate: X509::from_pem(client_certificate.to_string().as_bytes())?,
            client_private_key: PKey::private_key_from_pem(
                client_private_key.to_string().as_bytes(),
            )?,
            pinned_server_der: X509::from_pem(server_certificate.to_string().as_bytes())?.to_der()?,
        };
        Ok(Self {
            http: build_plain_client(request_timeout)?,
            tls_identity: Some(Arc::new(tls_identity)),
            request_timeout,
        })
    }
}
