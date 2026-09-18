const preview = document.getElementById("camera-preview") as HTMLVideoElement
const placeholder = document.getElementById("preview-placeholder") as HTMLElement
const startButton = document.getElementById("start-button") as HTMLButtonElement
const cameraButton = document.getElementById("camera-button") as HTMLButtonElement
const micButton = document.getElementById("mic-button") as HTMLButtonElement
const switchButton = document.getElementById("switch-button") as HTMLButtonElement
const cameraSelect = document.getElementById("camera-select") as HTMLSelectElement
const micSelect = document.getElementById("mic-select") as HTMLSelectElement
const applyDevicesButton = document.getElementById("apply-devices-button") as HTMLButtonElement
const mirrorToggle = document.getElementById("mirror-toggle") as HTMLInputElement
const meterFill = document.getElementById("meter-fill") as HTMLElement
const micLevel = document.getElementById("mic-level") as HTMLOutputElement
const liveBadge = document.getElementById("live-badge") as HTMLElement
const videoDetails = document.getElementById("video-details") as HTMLElement
const statusTitle = document.getElementById("status-title") as HTMLElement
const statusMessage = document.getElementById("status-message") as HTMLElement
const secureBadge = document.getElementById("secure-badge") as HTMLElement
const recordButton = document.getElementById("record-button") as HTMLButtonElement
const stopRecordButton = document.getElementById("stop-record-button") as HTMLButtonElement
const recordTime = document.getElementById("record-time") as HTMLElement
const clipCard = document.getElementById("clip-card") as HTMLElement
const clipPreview = document.getElementById("clip-preview") as HTMLVideoElement
const downloadLink = document.getElementById("download-link") as HTMLAnchorElement
const discardButton = document.getElementById("discard-button") as HTMLButtonElement

let stream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let meterFrame = 0
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let clipUrl: string | null = null
let recordStartedAt = 0
let recordTimer = 0

function setStatus(title: string, message: string) {
    statusTitle.innerText = title
    statusMessage.innerText = message
}

function formatError(error: unknown): string {
    if (!(error instanceof DOMException)) return error instanceof Error ? error.message : String(error)
    if (error.name === "NotAllowedError") return "Permission was denied, or the Tesla is not parked. Allow camera and microphone when prompted and try again."
    if (error.name === "NotFoundError") return "No camera or microphone was reported by this browser."
    if (error.name === "NotReadableError") return "The camera or microphone is busy in another app. Close the other app and retry."
    if (error.name === "OverconstrainedError") return "The selected media device is no longer available. Choose Default and retry."
    return `${error.name}: ${error.message}`
}

function stopMeter() {
    cancelAnimationFrame(meterFrame)
    meterFrame = 0
    analyser = null
    if (audioContext) void audioContext.close()
    audioContext = null
    meterFill.style.width = "0%"
    micLevel.value = "0%"
}

function startMeter(activeStream: MediaStream) {
    stopMeter()
    if (!activeStream.getAudioTracks().length) return
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return
    audioContext = new AudioContextClass()
    const source = audioContext.createMediaStreamSource(activeStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const draw = () => {
        if (!analyser) return
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
            const value = (sample - 128) / 128
            sum += value * value
        }
        const rms = Math.sqrt(sum / samples.length)
        const percent = Math.min(100, Math.round(rms * 260))
        meterFill.style.width = `${percent}%`
        micLevel.value = `${percent}%`
        meterFrame = requestAnimationFrame(draw)
    }
    void audioContext.resume()
    draw()
}

function stopStream() {
    if (recorder?.state === "recording") recorder.stop()
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    preview.srcObject = null
    placeholder.hidden = false
    liveBadge.innerText = "OFF"
    liveBadge.classList.add("is-off")
    videoDetails.innerText = "No media active"
    startButton.innerText = "Start Camera & Mic"
    cameraButton.disabled = true
    micButton.disabled = true
    switchButton.disabled = true
    recordButton.disabled = true
    stopMeter()
}

function fillSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], defaultLabel: string, selectedId: string) {
    select.replaceChildren(new Option(defaultLabel, ""))
    devices.forEach((device, index) => select.add(new Option(device.label || `${defaultLabel} ${index + 1}`, device.deviceId)))
    if (Array.from(select.options).some(option => option.value === selectedId)) select.value = selectedId
}

async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    const currentCamera = cameraSelect.value
    const currentMic = micSelect.value
    const cameras = devices.filter(device => device.kind === "videoinput")
    const microphones = devices.filter(device => device.kind === "audioinput")
    fillSelect(cameraSelect, cameras, "Default camera", currentCamera)
    fillSelect(micSelect, microphones, "Default microphone", currentMic)
    switchButton.disabled = !stream || cameras.length < 2
}

function selectedConstraints(): MediaStreamConstraints {
    return {
        video: cameraSelect.value
            ? { deviceId: { exact: cameraSelect.value }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: micSelect.value
            ? { deviceId: { exact: micSelect.value }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }
}

async function startMedia() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setStatus("Browser media unavailable", "Open this page through the HTTPS Moonlight address. This browser does not expose getUserMedia here.")
        return
    }
    startButton.disabled = true
    setStatus("Waiting for Tesla permission", "Allow both camera and microphone. Camera access works only while the car is parked.")
    try {
        const newStream = await navigator.mediaDevices.getUserMedia(selectedConstraints())
        stopStream()
        stream = newStream
        preview.srcObject = newStream
        preview.classList.toggle("is-mirrored", mirrorToggle.checked)
        await preview.play()
        placeholder.hidden = true
        liveBadge.innerText = "LIVE"
        liveBadge.classList.remove("is-off")
        const videoTrack = newStream.getVideoTracks()[0]
        const audioTrack = newStream.getAudioTracks()[0]
        const settings = videoTrack?.getSettings()
        videoDetails.innerText = videoTrack
            ? `${settings?.width || "?"}×${settings?.height || "?"}${settings?.frameRate ? ` · ${Math.round(settings.frameRate)} fps` : ""} · Mic ${audioTrack ? "ready" : "missing"}`
            : `Camera missing · Mic ${audioTrack ? "ready" : "missing"}`
        cameraButton.disabled = !videoTrack
        micButton.disabled = !audioTrack
        cameraButton.innerText = videoTrack?.enabled ? "Camera On" : "Camera Off"
        micButton.innerText = audioTrack?.enabled ? "Mic On" : "Mic Off"
        recordButton.disabled = !newStream.getTracks().length || typeof MediaRecorder === "undefined"
        startButton.innerText = "Restart Camera & Mic"
        startMeter(newStream)
        await refreshDevices()
        setStatus("Camera and microphone are live", "The preview stays local in this browser. Tap Start Recording only when you want to keep a temporary clip.")
    } catch (error) {
        stopStream()
        setStatus("Could not start media", formatError(error))
    } finally {
        startButton.disabled = false
    }
}

function toggleTrack(kind: "video" | "audio") {
    const track = kind === "video" ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    if (kind === "video") cameraButton.innerText = track.enabled ? "Camera On" : "Camera Off"
    else micButton.innerText = track.enabled ? "Mic On" : "Mic Off"
}

async function switchCamera() {
    const cameraOptions = Array.from(cameraSelect.options).filter(option => option.value)
    if (cameraOptions.length < 2) return
    const currentIndex = cameraOptions.findIndex(option => option.value === cameraSelect.value)
    cameraSelect.value = cameraOptions[(currentIndex + 1) % cameraOptions.length].value
    await startMedia()
}

function recordingMimeType(): string | undefined {
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    return candidates.find(type => MediaRecorder.isTypeSupported(type))
}

function updateRecordTime() {
    const seconds = Math.floor((Date.now() - recordStartedAt) / 1000)
    const twoDigits = (value: number) => (`0${value}`).slice(-2)
    recordTime.innerText = `${twoDigits(Math.floor(seconds / 60))}:${twoDigits(seconds % 60)}`
}

function startRecording() {
    if (!stream || typeof MediaRecorder === "undefined") return
    chunks = []
    const mimeType = recordingMimeType()
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data) })
    recorder.addEventListener("stop", () => {
        window.clearInterval(recordTimer)
        recordTimer = 0
        recordButton.disabled = false
        stopRecordButton.disabled = true
        recordButton.classList.remove("is-recording")
        recordButton.innerText = "Start Recording"
        if (!chunks.length) return
        if (clipUrl) URL.revokeObjectURL(clipUrl)
        const blob = new Blob(chunks, { type: recorder?.mimeType || "video/webm" })
        clipUrl = URL.createObjectURL(blob)
        clipPreview.src = clipUrl
        downloadLink.href = clipUrl
        downloadLink.download = blob.type.includes("mp4") ? "tesla-camera.mp4" : "tesla-camera.webm"
        clipCard.hidden = false
        setStatus("Recording ready", "Play it back, save it if the Tesla browser supports downloads, or discard it. It has not been uploaded.")
    })
    recorder.start(1000)
    recordStartedAt = Date.now()
    updateRecordTime()
    recordTimer = window.setInterval(updateRecordTime, 500)
    recordButton.disabled = true
    stopRecordButton.disabled = false
    recordButton.classList.add("is-recording")
    recordButton.innerText = "Recording…"
    setStatus("Recording locally", "The clip is being kept in browser memory only.")
}

function discardClip() {
    clipPreview.pause()
    clipPreview.removeAttribute("src")
    clipPreview.load()
    if (clipUrl) URL.revokeObjectURL(clipUrl)
    clipUrl = null
    chunks = []
    clipCard.hidden = true
    recordTime.innerText = "00:00"
    setStatus(stream ? "Camera and microphone are live" : "Ready", "Temporary recording discarded.")
}

document.getElementById("back-button")?.addEventListener("click", () => { window.location.href = "./" })
startButton.addEventListener("click", () => void startMedia())
cameraButton.addEventListener("click", () => toggleTrack("video"))
micButton.addEventListener("click", () => toggleTrack("audio"))
switchButton.addEventListener("click", () => void switchCamera())
applyDevicesButton.addEventListener("click", () => void startMedia())
mirrorToggle.addEventListener("change", () => preview.classList.toggle("is-mirrored", mirrorToggle.checked))
recordButton.addEventListener("click", startRecording)
stopRecordButton.addEventListener("click", () => recorder?.stop())
discardButton.addEventListener("click", discardClip)
navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices())
window.addEventListener("pagehide", stopStream)

if (window.isSecureContext) {
    secureBadge.innerText = "HTTPS · Private"
    secureBadge.classList.add("is-secure")
} else {
    secureBadge.innerText = "HTTPS required"
    secureBadge.classList.add("is-insecure")
}

if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera and microphone API unavailable", "Update the Tesla to 2026.26 or newer and open this page through HTTPS.")
    startButton.disabled = true
}
