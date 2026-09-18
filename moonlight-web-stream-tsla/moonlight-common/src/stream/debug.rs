use log::info;

use crate::stream::{
    audio::AudioDecoder,
    bindings::{
        AudioConfig, Capabilities, ConnectionStatus, DecodeResult, OpusMultistreamConfig, Stage,
        SupportedVideoFormats, VideoDecodeUnit, VideoFormat,
    },
    connection::ConnectionListener,
    video::VideoDecoder,
};

pub struct NullHandler;

impl VideoDecoder for NullHandler {
    fn setup(
        &mut self,
        format: VideoFormat,
        width: u32,
        height: u32,
        redraw_rate: u32,
        flags: i32,
    ) -> i32 {
        let _ = (format, width, height, redraw_rate, flags);

        0
    }

    fn start(&mut self) {}

    fn submit_decode_unit(&mut self, unit: VideoDecodeUnit<'_>) -> DecodeResult {
        let _ = unit;

        DecodeResult::Ok
    }

    fn stop(&mut self) {}

    fn supported_formats(&self) -> SupportedVideoFormats {
        SupportedVideoFormats::all()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::empty()
    }
}

impl AudioDecoder for NullHandler {
    fn setup(
        &mut self,
        audio_config: AudioConfig,
        stream_config: OpusMultistreamConfig,
        ar_flags: i32,
    ) -> i32 {
        let _ = (audio_config, stream_config, ar_flags);

        0
    }

    fn start(&mut self) {}
    fn decode_and_play_sample(&mut self, data: &[u8]) {
        let _ = data;
    }

    fn stop(&mut self) {}

    fn config(&self) -> AudioConfig {
        AudioConfig::STEREO
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities::empty()
    }
}

impl ConnectionListener for NullHandler {
    fn stage_starting(&mut self, stage: Stage) {
        let _ = stage;
    }
    fn stage_complete(&mut self, stage: Stage) {
        let _ = stage;
    }
    fn stage_failed(&mut self, stage: Stage, error_code: i32) {
        let _ = (stage, error_code);
    }

    fn connection_started(&mut self) {}
    fn connection_status_update(&mut self, status: ConnectionStatus) {
        let _ = status;
    }
    fn connection_terminated(&mut self, error_code: i32) {
        let _ = error_code;
    }

    fn log_message(&mut self, message: &str) {
        let _ = message;
    }

    fn set_hdr_mode(&mut self, hdr_enabled: bool) {
        let _ = hdr_enabled;
    }

    fn controller_rumble(
        &mut self,
        controller_number: u16,
        low_frequency_motor: u16,
        high_frequency_motor: u16,
    ) {
        let _ = (controller_number, low_frequency_motor, high_frequency_motor);
    }
    fn controller_rumble_triggers(
        &mut self,
        controller_number: u16,
        left_trigger_motor: u16,
        right_trigger_motor: u16,
    ) {
        let _ = (controller_number, left_trigger_motor, right_trigger_motor);
    }
    fn controller_set_adaptive_triggers(
        &mut self,
        controller_number: u16,
        event_flags: u8,
        type_left: u8,
        type_right: u8,
        left: &mut u8,
        right: &mut u8,
    ) {
        let _ = (
            controller_number,
            event_flags,
            type_left,
            type_right,
            left,
            right,
        );
    }
    fn controller_set_led(&mut self, controller_number: u16, r: u8, g: u8, b: u8) {
        let _ = (controller_number, r, g, b);
    }
    fn controller_set_motion_event_state(
        &mut self,
        controller_number: u16,
        motion_type: u8,
        report_rate_hz: u16,
    ) {
        let _ = (controller_number, motion_type, report_rate_hz);
    }
}

pub struct DebugHandler;

impl ConnectionListener for DebugHandler {
    fn stage_starting(&mut self, stage: Stage) {
        info!("[Moonlight]: Stage Starting: {stage:?}");
    }
    fn stage_complete(&mut self, stage: Stage) {
        info!("[Moonlight]: Stage Complete: {stage:?}");
    }
    fn stage_failed(&mut self, stage: Stage, error_code: i32) {
        info!("[Moonlight]: Stage Failed: {stage:?}, Error: {error_code}");
    }

    fn connection_started(&mut self) {
        info!("[Moonlight]: Connection Started");
    }
    fn connection_status_update(&mut self, status: ConnectionStatus) {
        info!("[Moonlight]: Connection Status Update: {status:?}");
    }
    fn connection_terminated(&mut self, error_code: i32) {
        info!("[Moonlight]: Connection Terminated: {error_code}");
    }

    fn log_message(&mut self, message: &str) {
        info!("[Moonlight]: {}", message.trim());
    }

    fn set_hdr_mode(&mut self, hdr_enabled: bool) {
        let _ = hdr_enabled;
    }

    fn controller_rumble(
        &mut self,
        controller_number: u16,
        low_frequency_motor: u16,
        high_frequency_motor: u16,
    ) {
        let _ = (controller_number, low_frequency_motor, high_frequency_motor);
    }
    fn controller_rumble_triggers(
        &mut self,
        controller_number: u16,
        left_trigger_motor: u16,
        right_trigger_motor: u16,
    ) {
        let _ = (controller_number, left_trigger_motor, right_trigger_motor);
    }
    fn controller_set_adaptive_triggers(
        &mut self,
        controller_number: u16,
        event_flags: u8,
        type_left: u8,
        type_right: u8,
        left: &mut u8,
        right: &mut u8,
    ) {
        let _ = (
            controller_number,
            event_flags,
            type_left,
            type_right,
            left,
            right,
        );
    }
    fn controller_set_led(&mut self, controller_number: u16, r: u8, g: u8, b: u8) {
        let _ = (controller_number, r, g, b);
    }
    fn controller_set_motion_event_state(
        &mut self,
        controller_number: u16,
        motion_type: u8,
        report_rate_hz: u16,
    ) {
        let _ = (controller_number, motion_type, report_rate_hz);
    }
}
