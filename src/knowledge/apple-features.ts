/** Small discovery index, not a complete device database. Revalidate sources for the user's SDK. */
const doc = (path: string) => `https://developer.apple.com/documentation/${path}`;
export const APPLE_FEATURES_REVIEWED = "2026-11-08";
export const IPHONE_18_PRO = {
  id: "iphone-18-pro",
  name: "iPhone 18 Pro",
  reviewed_at: APPLE_FEATURES_REVIEWED,
  sources: [
    "https://www.apple.com/iphone-18-pro/specs/",
    "https://www.apple.com/newsroom/2026/09/apple-debuts-iphone-18-pro-and-iphone-18-pro-max/",
  ],
  hardware: [
    "Action button",
    "Camera Control",
    "Variable-aperture Main camera",
    "Apple Reference Image capture on Main camera",
  ],
  caveat:
    "Device specifications establish hardware, not public API availability. Action button and Camera Control also exist on earlier models. Check exact symbols, OS, selected camera format and runtime capabilities.",
};
export const APPLE_FEATURES = [
  {
    id: "action-button",
    title: "Action button shortcuts",
    frameworks: ["AppIntents"],
    novelty: "Existing integration available on iPhone 18 Pro; not a new global button-event API.",
    symbols: ["AppIntent", "AppShortcutsProvider"],
    sources: [doc("appintents/hardware-interactions"), doc("appintents/app-shortcuts")],
    requirements: [
      "The person assigns an App Shortcut in Settings; the app does not assign the button itself.",
    ],
    fallback: "Expose the same action inside the app and through Shortcuts.",
    device_tests: ["Assign the shortcut, then test locked and unlocked invocation and authentication needs."],
  },
  {
    id: "camera-control-capture",
    title: "Camera Control capture events",
    frameworks: ["AVKit", "SwiftUI"],
    novelty: "Existing capture interaction available on iPhone 18 Pro.",
    symbols: ["AVCaptureEventInteraction", "View.onCameraCaptureEvent"],
    sources: [
      doc("avkit/avcaptureeventinteraction"),
      doc("avfoundation/enhancing-your-app-experience-with-the-camera-control"),
    ],
    requirements: [
      "Only active camera capture use cases receive events; this is not a background or general button hook.",
      "Handle event phases and disable the interaction when unable to capture; request camera permission.",
    ],
    fallback: "Keep an accessible on-screen shutter.",
    device_tests: [
      "Capture with the hardware button, deny permission, interrupt the camera session, and background the app.",
    ],
  },
  {
    id: "camera-control-adjustments",
    title: "Camera Control adjustment UI",
    frameworks: ["AVFoundation"],
    novelty: "Existing system and custom capture controls available on iPhone 18 Pro.",
    symbols: [
      "AVCaptureSession.supportsControls",
      "AVCaptureSession.canAddControl",
      "AVCaptureSlider",
      "AVCaptureIndexPicker",
    ],
    sources: [
      doc("avfoundation/enhancing-your-app-experience-with-the-camera-control"),
      doc("avfoundation/avcapturesession/supportscontrols"),
    ],
    requirements: [
      "Check supportsControls and canAddControl before adding each control; configure the controls delegate.",
      "Keep control values synchronized with app UI and the active capture format.",
    ],
    fallback: "Offer the same adjustments on screen when controls are unsupported.",
    device_tests: [
      "Exercise the controls overlay, camera/format switching, and fullscreen transitions on hardware.",
    ],
  },
  {
    id: "locked-camera-launch",
    title: "Camera launch while locked",
    frameworks: ["LockedCameraCapture", "AppIntents", "WidgetKit"],
    novelty: "Existing extension integration; separate from reacting to capture events.",
    symbols: ["LockedCameraCaptureExtension", "CameraCaptureIntent", "LockedCameraCaptureSession"],
    sources: [
      doc("lockedcameracapture/creating-a-camera-experience-for-the-lock-screen"),
      doc("avfoundation/avcam-building-a-camera-app"),
    ],
    requirements: [
      "Requires a capture extension and the appropriate intent/control integration; inspect every affected target.",
      "Locked capture extensions cannot use the network or the App Group shared container. Use session content storage and authenticated handoff.",
    ],
    fallback: "Open the camera experience in the main app after authentication.",
    device_tests: [
      "Test locked launch, permission denial, capture persistence, termination, and authenticated app handoff.",
    ],
  },
  {
    id: "variable-aperture",
    title: "Variable-aperture capture",
    frameworks: ["AVFoundation"],
    novelty: "New iPhone 18 Pro Main-camera capability; documented exposure APIs introduced in iOS 27.0.",
    symbols: [
      "AVCaptureDevice.setExposureModeCustom(lensAperture:duration:iso:completionHandler:)",
      "AVCaptureDevice.Format.supportsExposureModeCustom(lensAperture:duration:iso:)",
      "AVCaptureDevice.Format.minLensAperture",
      "AVCaptureDevice.Format.maxLensAperture",
    ],
    sources: [
      doc("avfoundation/avcapturedevice/setexposuremodecustom(lensaperture:duration:iso:completionhandler:)"),
      doc("avfoundation/avcapturedevice/format/supportsexposuremodecustom(lensaperture:duration:iso:)"),
      doc("avfoundation/avcapturedevice/format/minlensaperture"),
    ],
    requirements: [
      "Guard API availability and inspect the selected device's activeFormat aperture range; validate the complete exposure combination before applying it.",
      "Obtain the configuration lock. Photo quality prioritization can affect whether locked exposure values are retained; read the setter's current documentation.",
    ],
    fallback: "Use supported automatic exposure and hide physical-aperture adjustment when unavailable.",
    device_tests: [
      "Test supported and unsupported camera/format combinations, aperture limits, photo exposure behavior, and camera switching.",
    ],
  },
  {
    id: "reference-image",
    title: "Apple Reference Image detection and viewing",
    frameworks: ["Photos", "PhotosUI", "SwiftUI"],
    novelty:
      "iPhone 18 Pro introduces capture hardware; detection/viewing APIs are documented from OS 27.0 on listed platforms.",
    symbols: [
      "PHReferenceImageInfo",
      "PHReferenceImageInfo.imageContainsReferenceImageData",
      "View.photosReferenceImageViewer",
    ],
    sources: [
      doc("photos/phreferenceimageinfo"),
      doc("photos/phreferenceimageinfo/imagecontainsreferenceimagedata"),
      doc("swiftui/view/photosreferenceimageviewer(asset:onprocessingcompletion:)"),
    ],
    requirements: [
      "Check symbol availability and imageContainsReferenceImageData before offering the viewer; metadata inspection can perform IO.",
      "Reading/viewing an existing image is separate from producing sensor-signed data. These sources do not establish a third-party signing/capture API.",
    ],
    fallback: "Show the ordinary image without claiming authenticity or reference-image support.",
    device_tests: [
      "Use real supported photos and ordinary files; test absent metadata and the selected asset access flow.",
    ],
  },
];
