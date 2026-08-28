# Stash mobile direction references

These eight files are current implementation evidence captured from the native Android client. They replace the legacy direction artwork that previously occupied seven slots and the older Task 5 Android image that occupied the offline slot. Do not substitute browser, Expo web, mockup, or generated artwork for these files.

## Inventory

| File | Verified state | Status | SHA-256 |
| --- | --- | --- | --- |
| `01-pair-instance.png` | Unpaired HTTPS Instance form | Current native Android capture | `6819f2b928dd43f48adc64b86d94ea544acdd155dec25d7a77dd2d2531f42fbc` |
| `02-text-capture.png` | Paired text capture with the native keyboard | Current native Android capture | `6bec22cd1799bfd62955400f399dcb10df5b13da278d1c5bf1be29ed4878073e` |
| `03-checklist-capture.png` | Three-line checklist with the checklist switch enabled | Current native Android capture | `dc04adfa3a5aa462f9b165bb678ed23f2b7006ba5bcf5827d27695fa88795285` |
| `04-media-capture.png` | Active native voice recording (`Stop and save voice`) | Current native Android capture | `4ef8a8b21e6a5439b917a5e79a612afb90cfed5d35dee349dc60ae12beb9cd12` |
| `05-capture-structure.png` | Expanded Project, Tag, and Reminder controls | Current native Android capture | `f2e4cb9676b1f4ef02cefa215534cbb5637647eb3f964f737f33f0bc9b5e0bda` |
| `06-offline-saved.png` | Encrypted local save while the paired Instance is unreachable | Current native Android capture | `2c2da3b9332393157bd5a97236f742d2e1373e1e2327434abfadef8308d409f2` |
| `07-shared-to-stash.png` | Successful post-handoff state after a real Android `ACTION_SEND` | Current native Android capture | `0c676d04e965e0d2aa121c3490a3f4953dfa1ac503f3863904d98fb93aea8a53` |
| `08-outbox-attention.png` | Queued outbox requiring a valid Member session | Current native Android capture | `0066834fe046e66788136349f831e38aaf258b678941dfa0b5cb3fc66d7ae44f` |

Every PNG is the byte-exact output of Android `screencap`, 1280 by 2856 pixels, RGBA, without a device frame or post-capture retouching.

## Capture provenance

- Captured 2026-08-28/29 from package `app.stash.capture` on the local Android Emulator AVD `Pixel_9_Pro_API_36` (`sdk_gphone64_arm64`), Android 16 / API 36, 1280 by 2856.
- Built from the current branch as a native debug APK with an embedded Expo bundle. APK SHA-256: `c0c745eb1d39663fddf848650ef5f7eb790c402d4c6f2b5a43beb72b3c793d66`.
- Paired against a disposable HTTPS acceptance fixture backed by the real `startInstance` and `MobileCaptureService` paths. A disposable CA was trusted only by the temporary debug build, and `adb reverse tcp:43128 tcp:43128` connected the emulator to the fixture.
- Offline evidence was produced by removing the reverse mapping before saving, then restoring it so the queued capture could synchronize.
- Share evidence was produced through Android's real `ACTION_SEND` intent into `app.stash.capture/.MainActivity`. `07-shared-to-stash.png` intentionally shows the post-handoff synchronized Capture screen; the share payload is not echoed in this success state.
- Attention evidence used a fixture response that returned the real invalid-session condition. The client retained the outbox item and displayed `A valid Member session is required.`
- iOS was not captured or verified. These references document the current Android implementation only.

## Visual review

The complete contact sheet was inspected after capture. The journey uses one warm-paper surface language, carbon hierarchy, compact native controls, and a restrained status system. Vermilion remains concentrated on decisive actions, enabled controls, navigation emphasis, and attention; it is not repeated as decoration. Long status text wraps without clipping, the Android keyboard and system bars remain honest device context, the full Project/Tag/Reminder group fits without horizontal overflow, and the offline and invalid-session states are distinguishable without relying on color alone.

The files are intentionally raw product references rather than polished marketing screens. Regenerate all affected states from a verified native client whenever the mobile capture flow or its visual system changes, update this inventory and hashes, and inspect the complete contact sheet before committing.
