import Messages
import SafariServices
import TavraMessagesCore
import UIKit

@MainActor
final class MessagesViewController: MSMessagesAppViewController, @preconcurrency SFSafariViewControllerDelegate {
    private enum Palette {
        static let canvas = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.09, green: 0.09, blue: 0.08, alpha: 1)
                : UIColor(red: 0.975, green: 0.968, blue: 0.945, alpha: 1)
        }
        static let surface = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.14, green: 0.14, blue: 0.13, alpha: 1)
                : UIColor(red: 0.995, green: 0.992, blue: 0.98, alpha: 1)
        }
        static let quiet = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.18, green: 0.18, blue: 0.17, alpha: 1)
                : UIColor(red: 0.945, green: 0.938, blue: 0.915, alpha: 1)
        }
        static let approval = UIColor(red: 0.12, green: 0.40, blue: 0.88, alpha: 1)
        static let success = UIColor(red: 0.10, green: 0.55, blue: 0.35, alpha: 1)
        static let warning = UIColor(red: 0.73, green: 0.43, blue: 0.08, alpha: 1)
    }

    private let client = CheckoutSummaryClient()
    private let resumeStore = CheckoutResumeStore()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let statusPill = UIView()
    private let statusIcon = UIImageView()
    private let statusLabel = UILabel()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let reviewPanel = UIStackView()
    private let merchantLabel = UILabel()
    private let merchantDetailLabel = UILabel()
    private let itemCountLabel = UILabel()
    private let productsStack = UIStackView()
    private let contextStack = UIStackView()
    private let destinationLabel = UILabel()
    private let deliveryLabel = UILabel()
    private let allowanceLabel = UILabel()
    private let pricingStack = UIStackView()
    private let totalLabel = UILabel()
    private let expirationLabel = UILabel()
    private let trustLabel = UILabel()
    private let approveButton = UIButton(type: .system)
    private let activity = UIActivityIndicatorView(style: .medium)

    private var currentLink: CheckoutLink?
    private var currentSummary: CheckoutSummary?
    private var currentStatus: CheckoutPublicStatus?
    private var currentConversationScope: String?
    private var approvalWasOpened = false
    private weak var activeApprovalController: SFSafariViewController?
    private var loadTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var imageTasks: [Task<Void, Never>] = []
    private var productImageReadiness: [Int: CheckoutProductImageReadiness] = [:]

    override func loadView() {
        view = UIView(frame: .zero)
        configureView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        renderEmptyState()
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        let previousScope = currentConversationScope
        let scope = checkoutScope(for: conversation)
        currentConversationScope = scope

        if let selectedMessage = conversation.selectedMessage {
            loadSelectedCard(selectedMessage, conversationScope: scope)
            return
        }
        if let scope,
           previousScope == scope,
           let currentLink {
            loadCheckout(
                currentLink,
                conversationScope: scope,
                restoredApprovalState: approvalWasOpened
            )
            return
        }
        if let scope,
           let restored = resumeStore.restore(
            conversationScope: scope,
            allowedHosts: configuredCheckoutHosts
           ) {
            loadCheckout(
                restored.link,
                conversationScope: scope,
                restoredApprovalState: restored.approvalWasOpened
            )
            return
        }
        resetCheckoutState()
        renderEmptyState()
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        let scope = checkoutScope(for: conversation)
        currentConversationScope = scope
        loadSelectedCard(message, conversationScope: scope)
    }

    override func didResignActive(with conversation: MSConversation) {
        super.didResignActive(with: conversation)
        loadTask?.cancel()
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
        if activeApprovalController == nil {
            statusTask?.cancel()
        }
    }

    private func loadSelectedCard(
        _ message: MSMessage?,
        conversationScope: String?
    ) {
        guard let messageURL = message?.url else {
            resetCheckoutState()
            renderEmptyState()
            return
        }

        do {
            let link = try CheckoutLink(
                url: messageURL,
                allowedHosts: configuredCheckoutHosts
            )
            loadCheckout(
                link,
                conversationScope: conversationScope,
                restoredApprovalState: currentLink == link && approvalWasOpened
            )
        } catch {
            if let conversationScope {
                resumeStore.clear(conversationScope: conversationScope)
            }
            resetCheckoutState()
            renderError(error.localizedDescription)
        }
    }

    private func loadCheckout(
        _ link: CheckoutLink,
        conversationScope: String?,
        restoredApprovalState: Bool
    ) {
        let isSameCheckout = currentLink == link
        resetTasks()
        if !isSameCheckout {
            currentSummary = nil
            currentStatus = nil
        }
        approvalWasOpened = isSameCheckout
            ? approvalWasOpened || restoredApprovalState
            : restoredApprovalState
        currentLink = link
        currentConversationScope = conversationScope
        persistResume(for: link, conversationScope: conversationScope)
        requestPresentationStyle(.expanded)

        if isSameCheckout,
           let currentSummary,
           let currentStatus {
            presentLoadedCheckout(
                summary: currentSummary,
                status: currentStatus,
                link: link,
                conversationScope: conversationScope
            )
            return
        }

        renderLoadingState()
        loadTask = Task { [weak self] in
            guard let self else { return }
            async let summaryRequest = client.summary(for: link)
            do {
                let status = try await client.status(for: link)
                let summary = try await summaryRequest
                guard !Task.isCancelled,
                      currentLink == link,
                      currentConversationScope == conversationScope else {
                    return
                }
                presentLoadedCheckout(
                    summary: summary,
                    status: status,
                    link: link,
                    conversationScope: conversationScope
                )
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled,
                      currentLink == link,
                      currentConversationScope == conversationScope else {
                    return
                }
                renderError(error.localizedDescription)
            }
        }
    }

    private func presentLoadedCheckout(
        summary: CheckoutSummary,
        status: CheckoutPublicStatus,
        link: CheckoutLink,
        conversationScope: String?
    ) {
        currentSummary = summary
        currentStatus = status
        if case .awaitingResult = status {
            approvalWasOpened = true
        }
        persistResume(
            for: link,
            conversationScope: conversationScope,
            sessionExpiresAt: isoDate(summary.expiresAt)
        )
        render(summary)
        render(status)
        if status.isTerminal {
            clearPersistedCheckout(conversationScope: conversationScope)
            dismissSecureApprovalIfNeeded()
            return
        }
        startStatusPolling(for: link)
    }

    private func resetCheckoutState() {
        resetTasks()
        currentLink = nil
        currentSummary = nil
        currentStatus = nil
        currentConversationScope = nil
        approvalWasOpened = false
        productImageReadiness.removeAll()
    }

    private func resetTasks() {
        loadTask?.cancel()
        statusTask?.cancel()
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
    }

    private var configuredCheckoutHosts: Set<String> {
        let values = Bundle.main.object(
            forInfoDictionaryKey: "TavraAllowedCheckoutHosts"
        ) as? [String] ?? []
        return Set(values)
    }

    private func checkoutScope(for conversation: MSConversation) -> String? {
        let remotes = conversation.remoteParticipantIdentifiers
            .map { $0.uuidString.lowercased() }
            .sorted()
        guard !remotes.isEmpty else { return nil }
        return [
            "local:\(conversation.localParticipantIdentifier.uuidString.lowercased())",
            "remote:\(remotes.joined(separator: ","))",
        ].joined(separator: "|")
    }

    private func persistResume(
        for link: CheckoutLink,
        conversationScope: String?,
        sessionExpiresAt: Date? = nil
    ) {
        guard let conversationScope else { return }
        resumeStore.save(
            link: link,
            conversationScope: conversationScope,
            approvalWasOpened: approvalWasOpened,
            sessionExpiresAt: sessionExpiresAt
        )
    }

    private func clearPersistedCheckout(conversationScope: String?) {
        guard let conversationScope else { return }
        resumeStore.clear(conversationScope: conversationScope)
    }

    private func startStatusPolling(for link: CheckoutLink) {
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, currentLink == link {
                do {
                    let status = try await client.status(for: link)
                    guard !Task.isCancelled, currentLink == link else { return }
                    if case .awaitingResult = status {
                        approvalWasOpened = true
                    }
                    persistResume(
                        for: link,
                        conversationScope: currentConversationScope,
                        sessionExpiresAt: currentSummary.flatMap { isoDate($0.expiresAt) }
                    )
                    render(status)
                    if status.isTerminal {
                        clearPersistedCheckout(conversationScope: currentConversationScope)
                        dismissSecureApprovalIfNeeded()
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    setStatus(
                        text: "Reconnecting to Tavra",
                        symbol: "arrow.triangle.2.circlepath",
                        tone: .neutral
                    )
                    approveButton.configuration?.title = "Checking current status"
                    approveButton.isEnabled = false
                }

                do {
                    try await Task.sleep(for: .seconds(3))
                } catch {
                    return
                }
            }
        }
    }

    @objc private func continueWithPrava() {
        guard let link = currentLink,
              let currentStatus,
              case .pending = currentStatus,
              currentProductImageReadiness.allowsApproval,
              activeApprovalController == nil else {
            return
        }
        approvalWasOpened = true
        persistResume(
            for: link,
            conversationScope: currentConversationScope,
            sessionExpiresAt: currentSummary.flatMap { isoDate($0.expiresAt) }
        )
        apply(CheckoutExperienceCopy.status(.pending, approvalWasOpened: true), announce: true)
        startStatusPolling(for: link)

        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = false
        let safari = SFSafariViewController(
            url: link.approvalURL,
            configuration: configuration
        )
        safari.delegate = self
        safari.dismissButtonStyle = .close
        safari.preferredControlTintColor = Palette.approval
        activeApprovalController = safari
        present(safari, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        if activeApprovalController === controller {
            activeApprovalController = nil
        }
        guard let currentLink else { return }
        startStatusPolling(for: currentLink)
    }

    private func dismissSecureApprovalIfNeeded() {
        guard let safari = activeApprovalController,
              safari.presentingViewController != nil else {
            return
        }
        activeApprovalController = nil
        safari.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
            guard let self else { return }
            UIAccessibility.post(notification: .screenChanged, argument: self.titleLabel)
        }
    }

    private func configureView() {
        view.backgroundColor = Palette.canvas

        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        let safeArea = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: safeArea.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 20),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -20),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 18),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -28),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -40),
        ])

        contentStack.addArrangedSubview(makeHeader())
        contentStack.setCustomSpacing(24, after: contentStack.arrangedSubviews[0])
        contentStack.addArrangedSubview(makeStatusRow())

        let titleFont = UIFont.systemFont(ofSize: 31, weight: .bold)
        titleLabel.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: titleFont)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0
        titleLabel.textColor = .label
        titleLabel.accessibilityIdentifier = "checkout-title"
        contentStack.addArrangedSubview(titleLabel)

        detailLabel.font = .preferredFont(forTextStyle: .body)
        detailLabel.adjustsFontForContentSizeCategory = true
        detailLabel.numberOfLines = 0
        detailLabel.textColor = .secondaryLabel
        contentStack.addArrangedSubview(detailLabel)
        contentStack.setCustomSpacing(24, after: detailLabel)

        configureReviewPanel()
        contentStack.addArrangedSubview(reviewPanel)

        expirationLabel.font = .preferredFont(forTextStyle: .footnote)
        expirationLabel.adjustsFontForContentSizeCategory = true
        expirationLabel.numberOfLines = 0
        expirationLabel.textColor = .secondaryLabel
        expirationLabel.accessibilityIdentifier = "checkout-expiration"
        contentStack.addArrangedSubview(expirationLabel)

        contentStack.addArrangedSubview(makeTrustRow())

        var buttonConfiguration = UIButton.Configuration.filled()
        buttonConfiguration.title = "Approve securely with Prava"
        buttonConfiguration.cornerStyle = .large
        buttonConfiguration.buttonSize = .large
        buttonConfiguration.baseBackgroundColor = .label
        buttonConfiguration.baseForegroundColor = .systemBackground
        buttonConfiguration.titleTextAttributesTransformer = .init { incoming in
            var attributes = incoming
            attributes.font = .preferredFont(forTextStyle: .headline)
            return attributes
        }
        approveButton.configuration = buttonConfiguration
        approveButton.addTarget(self, action: #selector(continueWithPrava), for: .touchUpInside)
        approveButton.accessibilityHint = "Opens Prava’s protected approval in a trusted Safari view"
        approveButton.accessibilityIdentifier = "checkout-approve"
        approveButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        contentStack.addArrangedSubview(approveButton)
    }

    private func makeStatusRow() -> UIView {
        statusIcon.contentMode = .scaleAspectFit
        statusIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusIcon.widthAnchor.constraint(equalToConstant: 16),
            statusIcon.heightAnchor.constraint(equalToConstant: 16),
        ])

        activity.hidesWhenStopped = true
        activity.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            activity.widthAnchor.constraint(equalToConstant: 16),
            activity.heightAnchor.constraint(equalToConstant: 16),
        ])

        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "checkout-status"

        let pillStack = UIStackView(arrangedSubviews: [activity, statusIcon, statusLabel])
        pillStack.axis = .horizontal
        pillStack.alignment = .center
        pillStack.spacing = 7
        pillStack.translatesAutoresizingMaskIntoConstraints = false
        statusPill.addSubview(pillStack)
        statusPill.backgroundColor = Palette.quiet
        statusPill.layer.cornerRadius = 12
        statusPill.layer.cornerCurve = .continuous
        NSLayoutConstraint.activate([
            pillStack.leadingAnchor.constraint(equalTo: statusPill.leadingAnchor, constant: 11),
            pillStack.trailingAnchor.constraint(equalTo: statusPill.trailingAnchor, constant: -11),
            pillStack.topAnchor.constraint(equalTo: statusPill.topAnchor, constant: 7),
            pillStack.bottomAnchor.constraint(equalTo: statusPill.bottomAnchor, constant: -7),
        ])

        let row = UIStackView(arrangedSubviews: [statusPill, UIView()])
        row.axis = .horizontal
        row.alignment = .center
        return row
    }

    private func configureReviewPanel() {
        reviewPanel.axis = .vertical
        reviewPanel.spacing = 16
        reviewPanel.isLayoutMarginsRelativeArrangement = true
        reviewPanel.directionalLayoutMargins = .init(top: 20, leading: 18, bottom: 20, trailing: 18)
        reviewPanel.backgroundColor = Palette.surface
        reviewPanel.layer.cornerRadius = 22
        reviewPanel.layer.cornerCurve = .continuous
        reviewPanel.layer.borderWidth = 1 / UIScreen.main.scale
        reviewPanel.layer.borderColor = UIColor.separator.cgColor

        merchantLabel.text = "Recovery order"
        merchantLabel.font = .preferredFont(forTextStyle: .headline)
        merchantLabel.adjustsFontForContentSizeCategory = true
        merchantLabel.numberOfLines = 0

        merchantDetailLabel.font = .preferredFont(forTextStyle: .caption1)
        merchantDetailLabel.adjustsFontForContentSizeCategory = true
        merchantDetailLabel.textColor = .secondaryLabel
        merchantDetailLabel.numberOfLines = 0

        let merchantStack = UIStackView(arrangedSubviews: [merchantLabel, merchantDetailLabel])
        merchantStack.axis = .vertical
        merchantStack.spacing = 2

        itemCountLabel.font = .preferredFont(forTextStyle: .subheadline)
        itemCountLabel.adjustsFontForContentSizeCategory = true
        itemCountLabel.textColor = .secondaryLabel
        itemCountLabel.textAlignment = .right
        itemCountLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let reviewHeader = UIStackView(arrangedSubviews: [merchantStack, UIView(), itemCountLabel])
        reviewHeader.axis = .horizontal
        reviewHeader.alignment = .top
        reviewHeader.spacing = 10
        reviewPanel.addArrangedSubview(reviewHeader)
        reviewPanel.addArrangedSubview(makeSeparator())

        productsStack.axis = .vertical
        productsStack.spacing = 0
        reviewPanel.addArrangedSubview(productsStack)

        contextStack.axis = .vertical
        contextStack.spacing = 8
        destinationLabel.font = .preferredFont(forTextStyle: .subheadline)
        deliveryLabel.font = .preferredFont(forTextStyle: .subheadline)
        allowanceLabel.font = .preferredFont(forTextStyle: .subheadline)
        for label in [destinationLabel, deliveryLabel, allowanceLabel] {
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textColor = .secondaryLabel
            contextStack.addArrangedSubview(label)
        }
        reviewPanel.addArrangedSubview(contextStack)
        reviewPanel.addArrangedSubview(makeSeparator())

        pricingStack.axis = .vertical
        pricingStack.spacing = 8
        reviewPanel.addArrangedSubview(pricingStack)

        let totalCaption = UILabel()
        totalCaption.text = "Total"
        totalCaption.font = .preferredFont(forTextStyle: .headline)
        totalCaption.adjustsFontForContentSizeCategory = true

        let totalFont = UIFont.systemFont(ofSize: 25, weight: .bold)
        totalLabel.font = UIFontMetrics(forTextStyle: .title2).scaledFont(for: totalFont)
        totalLabel.adjustsFontForContentSizeCategory = true
        totalLabel.textAlignment = .right
        totalLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        totalLabel.accessibilityIdentifier = "checkout-total"
        let totalRow = UIStackView(arrangedSubviews: [totalCaption, UIView(), totalLabel])
        totalRow.axis = .horizontal
        totalRow.alignment = .firstBaseline
        totalRow.spacing = 10
        reviewPanel.addArrangedSubview(totalRow)
    }

    private func makeTrustRow() -> UIView {
        let shield = UIImageView(image: UIImage(systemName: "checkmark.shield"))
        shield.tintColor = Palette.success
        shield.contentMode = .scaleAspectFit
        shield.translatesAutoresizingMaskIntoConstraints = false
        shield.isAccessibilityElement = false
        NSLayoutConstraint.activate([
            shield.widthAnchor.constraint(equalToConstant: 22),
            shield.heightAnchor.constraint(equalToConstant: 22),
        ])

        trustLabel.font = .preferredFont(forTextStyle: .footnote)
        trustLabel.adjustsFontForContentSizeCategory = true
        trustLabel.numberOfLines = 0
        trustLabel.textColor = .secondaryLabel
        trustLabel.accessibilityIdentifier = "checkout-trust"

        let row = UIStackView(arrangedSubviews: [shield, trustLabel])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 10
        return row
    }

    private func makeSeparator() -> UIView {
        let separator = UIView()
        separator.backgroundColor = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
        return separator
    }

    private func makeHeader() -> UIView {
        let mark = UILabel()
        mark.text = "t"
        mark.textAlignment = .center
        mark.textColor = .systemBackground
        mark.backgroundColor = .label
        mark.font = .systemFont(ofSize: 23, weight: .bold)
        mark.layer.cornerRadius = 12
        mark.layer.cornerCurve = .continuous
        mark.clipsToBounds = true
        mark.translatesAutoresizingMaskIntoConstraints = false
        mark.isAccessibilityElement = true
        mark.accessibilityLabel = "Tavra"
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 42),
            mark.heightAnchor.constraint(equalToConstant: 42),
        ])

        let brand = UILabel()
        brand.text = "Tavra"
        brand.font = .preferredFont(forTextStyle: .title2)
        brand.adjustsFontForContentSizeCategory = true

        let secure = UILabel()
        secure.text = "Protected approval"
        secure.textAlignment = .right
        secure.textColor = .secondaryLabel
        secure.font = .preferredFont(forTextStyle: .subheadline)
        secure.adjustsFontForContentSizeCategory = true
        secure.numberOfLines = 2

        let stack = UIStackView(arrangedSubviews: [mark, brand, UIView(), secure])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 11
        return stack
    }

    private func renderEmptyState() {
        activity.stopAnimating()
        statusIcon.isHidden = false
        setCheckoutControlsVisible(false)
        setStatus(text: "Tavra ready", symbol: "message.fill", tone: .neutral)
        titleLabel.text = "Review recovery orders here"
        detailLabel.text = "Open a Tavra order card in this conversation. Product, delivery, approval, and order status stay together."
        replaceProducts(with: [])
        replacePricing(nil, currency: "USD")
        totalLabel.text = nil
        expirationLabel.text = nil
    }

    private func renderLoadingState() {
        setCheckoutControlsVisible(false)
        statusIcon.isHidden = true
        statusLabel.text = "Opening secure review"
        statusLabel.textColor = .secondaryLabel
        titleLabel.text = "Opening your order"
        detailLabel.text = "Tavra is checking this card before showing any details."
        replaceProducts(with: [])
        replacePricing(nil, currency: "USD")
        totalLabel.text = nil
        expirationLabel.text = nil
        activity.startAnimating()
    }

    private func renderError(_ message: String) {
        activity.stopAnimating()
        statusIcon.isHidden = false
        setCheckoutControlsVisible(false)
        setStatus(text: "Unable to open order", symbol: "exclamationmark.circle.fill", tone: .failure)
        titleLabel.text = "This Tavra card can’t be opened"
        detailLabel.text = clean(message)
        replaceProducts(with: [])
        replacePricing(nil, currency: "USD")
        totalLabel.text = nil
        expirationLabel.text = nil
        UIAccessibility.post(notification: .screenChanged, argument: titleLabel)
    }

    private func render(_ summary: CheckoutSummary) {
        activity.stopAnimating()
        statusIcon.isHidden = false
        setCheckoutControlsVisible(true)
        productImageReadiness = Dictionary(
            uniqueKeysWithValues: summary.requiredLiveProductImageIndexes.map {
                ($0, CheckoutProductImageReadiness.loading)
            }
        )
        apply(.review(orderDescription: summary.order.description), announce: false)
        configureMerchant(summary.order.merchant)
        configureContext(summary.order)
        replaceProducts(with: summary.order.products, currency: summary.order.currency)
        replacePricing(summary.order.pricing, currency: summary.order.currency)
        totalLabel.text = money(summary.order.totalAmount, currency: summary.order.currency)
        expirationLabel.text = expirationText(for: summary)
    }

    private func setCheckoutControlsVisible(_ isVisible: Bool) {
        reviewPanel.isHidden = !isVisible
        expirationLabel.isHidden = !isVisible
        trustLabel.superview?.isHidden = !isVisible
        approveButton.isHidden = !isVisible
    }

    private func render(_ status: CheckoutPublicStatus) {
        currentStatus = status
        if case .pending = status, !approvalWasOpened, currentSummary != nil {
            apply(
                CheckoutExperienceCopy.status(status, approvalWasOpened: false),
                announce: false
            )
            return
        }
        let copy = CheckoutExperienceCopy.status(status, approvalWasOpened: approvalWasOpened)
        apply(copy, announce: status.isTerminal)
    }

    private func apply(_ copy: CheckoutExperienceCopy, announce: Bool) {
        let copy = copy.gatedByProductImage(currentProductImageReadiness)
        activity.stopAnimating()
        statusIcon.isHidden = false
        setStatus(text: copy.status, symbol: symbol(for: copy.stage), tone: copy.tone)
        titleLabel.text = copy.title
        detailLabel.text = copy.detail
        trustLabel.text = copy.trust
        approveButton.configuration?.title = copy.buttonTitle
        approveButton.isEnabled = copy.buttonEnabled
        approveButton.isHidden = copy.buttonTitle == nil
        approveButton.accessibilityValue = copy.buttonEnabled ? nil : copy.status
        if copy.showsExpiration, let currentSummary {
            expirationLabel.text = expirationText(for: currentSummary)
            expirationLabel.isHidden = false
        } else {
            expirationLabel.text = nil
            expirationLabel.isHidden = true
        }
        if announce {
            UIAccessibility.post(notification: .announcement, argument: "\(copy.status). \(copy.title)")
        }
    }

    private func setStatus(
        text: String,
        symbol: String,
        tone: CheckoutExperienceTone
    ) {
        statusLabel.text = text
        statusIcon.image = UIImage(systemName: symbol)
        let color = color(for: tone)
        statusLabel.textColor = color
        statusIcon.tintColor = color
        statusPill.accessibilityLabel = text
        statusPill.accessibilityTraits = tone == .failure ? [.staticText] : []
    }

    private func symbol(for stage: CheckoutExperienceStage) -> String {
        switch stage {
        case .review:
            "doc.text.magnifyingglass"
        case .approvalPending:
            "lock.shield"
        case .authorized:
            "checkmark.shield"
        case .orderPlaced:
            "checkmark.circle.fill"
        case .sandboxApproved:
            "checkmark.circle"
        case .sandboxValidated:
            "checkmark.shield"
        case .failed:
            "xmark.circle.fill"
        case .reconciliation:
            "clock.badge.exclamationmark"
        }
    }

    private func color(for tone: CheckoutExperienceTone) -> UIColor {
        switch tone {
        case .neutral:
            .secondaryLabel
        case .active:
            Palette.approval
        case .success:
            Palette.success
        case .warning:
            Palette.warning
        case .failure:
            .systemRed
        }
    }

    private func configureMerchant(_ merchant: CheckoutSummary.Merchant?) {
        merchantLabel.text = merchant.map { clean($0.name) } ?? "Recovery order"
        merchantDetailLabel.text = [merchant?.domain, merchant?.countryCode]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
        merchantDetailLabel.isHidden = merchantDetailLabel.text?.isEmpty != false
    }

    private func configureContext(_ order: CheckoutSummary.Order) {
        destinationLabel.text = order.destination.map { "Deliver to  \(clean($0.maskedLabel))" }
        let deliveryPrefix = order.delivery?.verified == true ? "Verified delivery" : "Delivery"
        deliveryLabel.text = order.delivery.map { "\(deliveryPrefix)  \(clean($0.label))" }
        allowanceLabel.text = order.allowance.map {
            "Allowance  \(money($0.amount, currency: $0.currency))"
        }
        for label in [destinationLabel, deliveryLabel, allowanceLabel] {
            label.isHidden = label.text == nil
        }
        contextStack.isHidden = [destinationLabel, deliveryLabel, allowanceLabel]
            .allSatisfy(\.isHidden)
    }

    private func replaceProducts(
        with products: [CheckoutSummary.Order.Product],
        currency: String = "USD"
    ) {
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
        clear(productsStack)
        productsStack.isHidden = products.isEmpty
        let totalQuantity = products.reduce(into: 0) { $0 += $1.quantity }
        itemCountLabel.text = products.isEmpty
            ? nil
            : "\(totalQuantity) \(totalQuantity == 1 ? "item" : "items")"

        for (index, product) in products.enumerated() {
            if index > 0 {
                productsStack.addArrangedSubview(makeSeparator())
            }
            let view = products.count == 1
                ? makeHeroProduct(product, index: index, currency: currency)
                : makeCompactProduct(product, index: index, currency: currency)
            productsStack.addArrangedSubview(view)
        }
    }

    private func makeHeroProduct(
        _ product: CheckoutSummary.Order.Product,
        index: Int,
        currency: String
    ) -> UIView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 14
        stack.accessibilityIdentifier = "checkout-product-\(index)"
        if product.imageUrl != nil {
            let image = makeProductImage(product, index: index)
            image.heightAnchor.constraint(equalToConstant: 190).isActive = true
            stack.addArrangedSubview(image)
            loadProductImage(product, index: index, into: image)
        }
        stack.addArrangedSubview(makeProductText(product, currency: currency))
        return stack
    }

    private func makeCompactProduct(
        _ product: CheckoutSummary.Order.Product,
        index: Int,
        currency: String
    ) -> UIView {
        var views: [UIView] = []
        if product.imageUrl != nil {
            let image = makeProductImage(product, index: index)
            NSLayoutConstraint.activate([
                image.widthAnchor.constraint(equalToConstant: 76),
                image.heightAnchor.constraint(equalToConstant: 76),
            ])
            views.append(image)
            loadProductImage(product, index: index, into: image)
        }
        views.append(makeProductText(product, currency: currency))
        let row = UIStackView(arrangedSubviews: views)
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = .init(top: 10, leading: 0, bottom: 10, trailing: 0)
        row.accessibilityIdentifier = "checkout-product-\(index)"
        return row
    }

    private func makeProductImage(
        _ product: CheckoutSummary.Order.Product,
        index: Int
    ) -> UIImageView {
        let image = UIImageView(image: UIImage(systemName: "photo"))
        image.contentMode = .center
        image.tintColor = .tertiaryLabel
        image.backgroundColor = Palette.quiet
        image.layer.cornerRadius = 14
        image.layer.cornerCurve = .continuous
        image.clipsToBounds = true
        image.translatesAutoresizingMaskIntoConstraints = false
        image.isAccessibilityElement = true
        image.accessibilityLabel = clean(product.imageAltText ?? product.description)
        image.accessibilityIdentifier = "checkout-product-image-\(index)"
        return image
    }

    private func makeProductText(
        _ product: CheckoutSummary.Order.Product,
        currency: String
    ) -> UIView {
        let name = UILabel()
        let productName = clean(product.description)
        name.text = product.quantity == 1
            ? productName
            : "\(product.quantity) × \(productName)"
        name.font = .preferredFont(forTextStyle: .body)
        name.adjustsFontForContentSizeCategory = true
        name.numberOfLines = 0

        let variant = UILabel()
        variant.text = product.displayVariant.map(clean)
        variant.font = .preferredFont(forTextStyle: .subheadline)
        variant.adjustsFontForContentSizeCategory = true
        variant.textColor = .secondaryLabel
        variant.numberOfLines = 0
        variant.isHidden = variant.text == nil

        let descriptionStack = UIStackView(arrangedSubviews: [name, variant])
        descriptionStack.axis = .vertical
        descriptionStack.spacing = 3

        let price = UILabel()
        price.text = money(multipliedAmount(product.unitPrice, by: product.quantity), currency: currency)
        price.font = .preferredFont(forTextStyle: .headline)
        price.adjustsFontForContentSizeCategory = true
        price.numberOfLines = 1
        price.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [descriptionStack, UIView(), price])
        row.axis = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 12
        return row
    }

    private func loadProductImage(
        _ product: CheckoutSummary.Order.Product,
        index: Int,
        into imageView: UIImageView
    ) {
        guard let imageURL = product.imageUrl,
              let link = currentLink,
              let checkoutID = currentSummary?.checkoutId else {
            return
        }
        let task = Task { [weak self, weak imageView] in
            guard let self, let imageView else { return }
            do {
                let productImage = try await client.productImage(at: imageURL, for: link)
                guard !Task.isCancelled,
                      currentLink == link,
                      currentSummary?.checkoutId == checkoutID,
                      currentSummary?.order.products.indices.contains(index) == true,
                      currentSummary?.order.products[index].imageUrl == imageURL else {
                    return
                }
                imageView.image = UIImage(cgImage: productImage.cgImage)
                imageView.contentMode = .scaleAspectFill
                imageView.tintColor = nil
                updateProductImageReadiness(
                    .ready,
                    index: index,
                    imageURL: imageURL,
                    checkoutID: checkoutID,
                    announce: false
                )
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled,
                      currentLink == link,
                      currentSummary?.checkoutId == checkoutID,
                      currentSummary?.order.products.indices.contains(index) == true,
                      currentSummary?.order.products[index].imageUrl == imageURL else {
                    return
                }
                imageView.isHidden = true
                updateProductImageReadiness(
                    .unavailable,
                    index: index,
                    imageURL: imageURL,
                    checkoutID: checkoutID,
                    announce: true
                )
            }
        }
        imageTasks.append(task)
    }

    private var currentProductImageReadiness: CheckoutProductImageReadiness {
        CheckoutProductImageReadiness.aggregate(Array(productImageReadiness.values))
    }

    private func updateProductImageReadiness(
        _ readiness: CheckoutProductImageReadiness,
        index: Int,
        imageURL: URL,
        checkoutID: String,
        announce: Bool
    ) {
        guard productImageReadiness[index] != nil,
              currentSummary?.checkoutId == checkoutID,
              currentSummary?.order.products.indices.contains(index) == true,
              currentSummary?.order.products[index].imageUrl == imageURL else {
            return
        }
        productImageReadiness[index] = readiness
        guard let currentStatus else { return }
        let copy = CheckoutExperienceCopy.status(
            currentStatus,
            approvalWasOpened: approvalWasOpened
        )
        apply(copy, announce: announce)
    }

    private func replacePricing(
        _ pricing: CheckoutSummary.Pricing?,
        currency: String
    ) {
        clear(pricingStack)
        guard let pricing else {
            pricingStack.isHidden = true
            return
        }
        pricingStack.isHidden = false
        pricingStack.addArrangedSubview(makePriceRow("Subtotal", pricing.subtotal, currency: currency))
        if NSDecimalNumber(string: pricing.shipping) != .zero {
            pricingStack.addArrangedSubview(makePriceRow("Shipping", pricing.shipping, currency: currency))
        }
        if NSDecimalNumber(string: pricing.tax) != .zero {
            pricingStack.addArrangedSubview(makePriceRow("Tax", pricing.tax, currency: currency))
        }
        if let discount = pricing.discount, NSDecimalNumber(string: discount) != .zero {
            pricingStack.addArrangedSubview(makePriceRow("Discount", "-\(discount)", currency: currency))
        }
        pricingStack.addArrangedSubview(makeSeparator())
    }

    private func makePriceRow(_ label: String, _ amount: String, currency: String) -> UIView {
        let caption = UILabel()
        caption.text = label
        caption.font = .preferredFont(forTextStyle: .subheadline)
        caption.adjustsFontForContentSizeCategory = true
        caption.textColor = .secondaryLabel

        let value = UILabel()
        let isNegative = amount.hasPrefix("-")
        value.text = (isNegative ? "-" : "") + money(
            isNegative ? String(amount.dropFirst()) : amount,
            currency: currency
        )
        value.font = .preferredFont(forTextStyle: .subheadline)
        value.adjustsFontForContentSizeCategory = true
        value.textColor = .secondaryLabel
        let row = UIStackView(arrangedSubviews: [caption, UIView(), value])
        row.axis = .horizontal
        row.alignment = .firstBaseline
        return row
    }

    private func clear(_ stack: UIStackView) {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private func multipliedAmount(_ amount: String, by quantity: Int) -> String {
        NSDecimalNumber(string: amount)
            .multiplying(by: NSDecimalNumber(value: quantity))
            .stringValue
    }

    private func money(_ amount: String, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.locale = .current
        return formatter.string(from: NSDecimalNumber(string: amount)) ?? "\(currency) \(amount)"
    }

    private func expirationText(for summary: CheckoutSummary) -> String {
        if let quote = summary.order.quote {
            return timeText(quote.expiresAt, prefix: "Quote held until")
        }
        return timeText(summary.expiresAt, prefix: "Secure approval available until")
    }

    private func timeText(_ timestamp: String, prefix: String) -> String {
        guard let date = isoDate(timestamp) else { return "This secure review expires soon." }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return "\(prefix) \(formatter.string(from: date))."
    }

    private func isoDate(_ timestamp: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: timestamp) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: timestamp)
    }

    private func clean(_ value: String) -> String {
        value
            .replacingOccurrences(of: "—", with: ",")
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "--", with: ",")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
