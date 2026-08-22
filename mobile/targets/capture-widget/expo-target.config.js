module.exports = (config) => ({
  type: "widget",
  name: "StashCaptureWidget",
  displayName: "Stash Capture",
  bundleIdentifier: ".capture-widget",
  deploymentTarget: "17.0",
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
