(() => {
  const isAv1 = (type) => /\b(?:av01|av1)\b/i.test(String(type || ''));

  if (globalThis.MediaSource?.isTypeSupported) {
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => isAv1(type) ? false : original(type);
  }

  if (globalThis.HTMLMediaElement?.prototype?.canPlayType) {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      return isAv1(type) ? '' : original.call(this, type);
    };
  }

  if (navigator.mediaCapabilities?.decodingInfo) {
    const original = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
    navigator.mediaCapabilities.decodingInfo = async (configuration) => {
      if (isAv1(configuration?.video?.contentType)) {
        return {supported: false, smooth: false, powerEfficient: false};
      }
      return original(configuration);
    };
  }
})();
