//
//  AppDelegate.swift
//  TronPick Gems Autoplay
//
//  Created by Andry Tokiniaina on 03/08/2026.
//

import Cocoa
import IOKit.pwr_mgt

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private var displayAssertion = IOPMAssertionID(0)
    private var systemAssertion = IOPMAssertionID(0)

    func applicationDidFinishLaunching(_ notification: Notification) {
        preventSleep()
    }

    func applicationWillTerminate(_ notification: Notification) {
        allowSleep()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    /// Keeps the display — and therefore the Mac — awake for as long as this app
    /// is running. Safari's Screen Wake Lock only covers a tab that is visible
    /// and is dropped the moment it is hidden, so the dependable place to hold
    /// this is a real power assertion in a process of our own.
    private func preventSleep() {
        let reason = "TronPick Gems Autoplay is running" as CFString

        let display = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason,
            &displayAssertion)

        let system = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason,
            &systemAssertion)

        NSLog("[Gems Autoplay] keep-awake display=%d system=%d", display, system)
    }

    private func allowSleep() {
        if displayAssertion != IOPMAssertionID(0) {
            IOPMAssertionRelease(displayAssertion)
            displayAssertion = IOPMAssertionID(0)
        }
        if systemAssertion != IOPMAssertionID(0) {
            IOPMAssertionRelease(systemAssertion)
            systemAssertion = IOPMAssertionID(0)
        }
    }
}
