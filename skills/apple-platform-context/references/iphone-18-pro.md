# iPhone 18 Pro: first feature investigation

Reviewed 2026-11-08. Begin with `apple_feature_context action=discover device=iphone-18-pro`. Re-fetch exact API references and matching release notes for the user's project before implementation.

Apple lists Action button and Camera Control in the [device specifications](https://www.apple.com/iphone-18-pro/specs/). Its [launch announcement](https://www.apple.com/newsroom/2026/09/apple-debuts-iphone-18-pro-and-iphone-18-pro-max/) describes a variable-aperture Main camera and Apple Reference Image. Those hardware claims are distinct from public API contracts. The buttons also exist on earlier devices; do not describe them as newly introduced on this model. Keep Pro, Pro Max and other devices distinct unless evidence supports the same behavior.

| Requested experience | Investigate | Boundary / fallback |
|---|---|---|
| Run an app action from Action button | App Intents, App Shortcuts, AppShortcutsProvider | User assigns the shortcut; keep an in-app action. |
| Capture with Camera Control | AVCaptureEventInteraction or the matching SwiftUI capture-event API | Active camera capture only; keep an accessible on-screen shutter. |
| Adjust camera settings using Camera Control | AVFoundation controls, supportsControls, canAddControl | Inspect session support and each proposed control; retain on-screen adjustments. |
| Launch a camera while locked | LockedCameraCapture, CameraCaptureIntent and control integration | Requires extension work; validate restricted storage and authenticated handoff. |
| Adjust physical lens aperture | New lens-aperture exposure setter and active-format support checks | Inspect OS/SDK availability, selected camera and format; retain supported auto exposure. |
| Detect and display Apple Reference Image | PHReferenceImageInfo and photosReferenceImageViewer | Check the actual file's data; ordinary images remain viewable without authenticity claims. |

## Action button and Camera Control

[Hardware interactions](https://developer.apple.com/documentation/appintents/hardware-interactions) describes shortcut assignment through Settings. It does not establish a general button-event interception API.

[AVCaptureEventInteraction](https://developer.apple.com/documentation/avkit/avcaptureeventinteraction) handles capture interactions while the app actively uses the camera; background operation is a separate concern. [Camera Control integration](https://developer.apple.com/documentation/avfoundation/enhancing-your-app-experience-with-the-camera-control) distinguishes capture events, the controls interface, and camera launch. Check [supportsControls](https://developer.apple.com/documentation/avfoundation/avcapturesession/supportscontrols) and canAddControl, including format changes and control count limits.

For locked launch, read [the capture extension guide](https://developer.apple.com/documentation/lockedcameracapture/creating-a-camera-experience-for-the-lock-screen) and [AVCam sample](https://developer.apple.com/documentation/avfoundation/avcam-building-a-camera-app). Do not put a network-dependent workflow or shared-container dependency into the restricted extension. Test permission and authentication transitions on the physical device.

## Variable aperture: new capability with a public API

Apple's current metadata lists iOS 27.0 introduction for:

- [setExposureModeCustom(lensAperture:duration:iso:completionHandler:)](https://developer.apple.com/documentation/avfoundation/avcapturedevice/setexposuremodecustom(lensaperture:duration:iso:completionhandler:))
- [AVCaptureDevice.Format.supportsExposureModeCustom(lensAperture:duration:iso:)](https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/supportsexposuremodecustom(lensaperture:duration:iso:))
- [minLensAperture](https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/minlensaperture), paired with maxLensAperture on the selected format.

Use the format's supported range and validate the proposed aperture/duration/ISO combination. Acquire the configuration lock before applying it. Do not assume every lens or format supports adjustment. The existing read-only lensAperture property is not itself an aperture-control API. Review the setter's photo-prioritization behavior when precise captured exposure matters.

Test aperture limits, camera and format switching, capture output, and the fallback on fixed-aperture hardware. Simulator results cannot establish physical-aperture behavior.

## Apple Reference Image: distinguish consumption from capture

Current metadata lists OS 27.0 introductions on supported platforms for [PHReferenceImageInfo](https://developer.apple.com/documentation/photos/phreferenceimageinfo), [imageContainsReferenceImageData](https://developer.apple.com/documentation/photos/phreferenceimageinfo/imagecontainsreferenceimagedata), and [photosReferenceImageViewer(asset:onProcessingCompletion:)](https://developer.apple.com/documentation/swiftui/view/photosreferenceimageviewer(asset:onprocessingcompletion:)). Verify each platform independently rather than applying the phone's introduction version to all targets.

These provide a concrete route for inspecting and viewing an existing image. They do not by themselves establish that a third-party capture pipeline can generate sensor-signed Reference Image data. Research creation separately if requested. Base viewer visibility on actual image data, handle unsupported platforms, and avoid blocking the UI while inspecting metadata. Exercise real supported assets and ordinary images; do not infer authenticity from device identity or a filename.

## Evidence to leave behind

Record exact symbols, sources, project fingerprint, SDK/deployment facts, capability checks, fallback and unresolved capture questions. Track compilation, simulator tests and physical iPhone 18 Pro tests separately, with actual OS and app build. Use [Xcode release notes](https://developer.apple.com/documentation/xcode-release-notes) to find caveats matching the installed toolchain; a note for another release is not automatically applicable.
