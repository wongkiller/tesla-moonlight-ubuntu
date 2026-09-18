(() => {
  const isUnsafeVideoCodec = (type) => /\b(?:av01|av1|vp09|vp9|vp8)\b/i.test(String(type || ''));

  if (globalThis.MediaSource?.isTypeSupported) {
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => isUnsafeVideoCodec(type) ? false : original(type);
  }

  if (globalThis.HTMLMediaElement?.prototype?.canPlayType) {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      return isUnsafeVideoCodec(type) ? '' : original.call(this, type);
    };
  }

  if (navigator.mediaCapabilities?.decodingInfo) {
    const original = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
    navigator.mediaCapabilities.decodingInfo = async (configuration) => {
      if (isUnsafeVideoCodec(configuration?.video?.contentType)) {
        return {supported: false, smooth: false, powerEfficient: false};
      }
      return original(configuration);
    };
  }
})();
