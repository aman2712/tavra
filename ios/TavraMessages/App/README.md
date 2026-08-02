# Tavra Messages container

This is intentionally a code-free Messages-only containing app. XcodeGen creates
its `Info.plist`, and the `TavraMessagesExtension` target provides the UI that runs
inside Messages.

Before App Store or TestFlight distribution, add final Tavra application and
iMessage app icon catalogs in this directory and reference them from `project.yml`.
