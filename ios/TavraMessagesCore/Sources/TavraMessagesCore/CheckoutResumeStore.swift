import Foundation

public struct CheckoutResumeState: Equatable, Sendable {
    public let link: CheckoutLink
    public let approvalWasOpened: Bool
    public let expiresAt: Date

    public init(link: CheckoutLink, approvalWasOpened: Bool, expiresAt: Date) {
        self.link = link
        self.approvalWasOpened = approvalWasOpened
        self.expiresAt = expiresAt
    }
}

/// Keeps one short-lived checkout capability inside the Messages extension's
/// private preferences. The caller supplies a conversation scope and trusted
/// hosts again when restoring, so a record cannot cross conversations or bypass
/// normal CheckoutLink validation.
public struct CheckoutResumeStore {
    private struct Record: Codable {
        let approvalURL: String
        let conversationScope: String
        let approvalWasOpened: Bool
        let expiresAt: Date
    }

    private let defaults: UserDefaults
    private let storageKey: String
    private let maximumLifetime: TimeInterval
    private let now: () -> Date

    public init(
        defaults: UserDefaults = .standard,
        storageKey: String = "space.tavra.messages.active-checkout.v1",
        maximumLifetime: TimeInterval = 15 * 60,
        now: @escaping () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.maximumLifetime = max(1, min(maximumLifetime, 30 * 60))
        self.now = now
    }

    public func save(
        link: CheckoutLink,
        conversationScope: String,
        approvalWasOpened: Bool,
        sessionExpiresAt: Date? = nil
    ) {
        guard let scope = normalizedScope(conversationScope) else { return }
        let savedAt = now()
        let maximumExpiry = savedAt.addingTimeInterval(maximumLifetime)
        let expiresAt = min(sessionExpiresAt ?? maximumExpiry, maximumExpiry)
        guard expiresAt > savedAt else {
            clear(conversationScope: scope)
            return
        }

        let record = Record(
            approvalURL: link.approvalURL.absoluteString,
            conversationScope: scope,
            approvalWasOpened: approvalWasOpened,
            expiresAt: expiresAt
        )
        guard let data = try? JSONEncoder().encode(record) else {
            defaults.removeObject(forKey: storageKey)
            return
        }
        defaults.set(data, forKey: storageKey)
    }

    public func restore(
        conversationScope: String,
        allowedHosts: Set<String>
    ) -> CheckoutResumeState? {
        guard let scope = normalizedScope(conversationScope),
              let data = defaults.data(forKey: storageKey),
              let record = try? JSONDecoder().decode(Record.self, from: data) else {
            return nil
        }
        guard record.conversationScope == scope else { return nil }
        guard record.expiresAt > now(),
              let url = URL(string: record.approvalURL),
              let link = try? CheckoutLink(url: url, allowedHosts: allowedHosts) else {
            defaults.removeObject(forKey: storageKey)
            return nil
        }
        return CheckoutResumeState(
            link: link,
            approvalWasOpened: record.approvalWasOpened,
            expiresAt: record.expiresAt
        )
    }

    public func clear(conversationScope: String? = nil) {
        guard let conversationScope else {
            defaults.removeObject(forKey: storageKey)
            return
        }
        guard let scope = normalizedScope(conversationScope),
              let data = defaults.data(forKey: storageKey),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              record.conversationScope == scope else {
            return
        }
        defaults.removeObject(forKey: storageKey)
    }

    private func normalizedScope(_ value: String) -> String? {
        let scope = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !scope.isEmpty, scope.count <= 512 else { return nil }
        return scope
    }
}
