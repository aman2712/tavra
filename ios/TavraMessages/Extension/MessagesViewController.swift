import Messages
import SafariServices
import TavraMessagesCore
import UIKit

@MainActor
final class MessagesViewController: MSMessagesAppViewController, @preconcurrency SFSafariViewControllerDelegate {
    private let client = CheckoutSummaryClient()

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let statusLabel = UILabel()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let reviewPanel = UIStackView()
    private let itemCountLabel = UILabel()
    private let productsStack = UIStackView()
    private let totalCaptionLabel = UILabel()
    private let totalLabel = UILabel()
    private let expirationLabel = UILabel()
    private let trustLabel = UILabel()
    private let approveButton = UIButton(type: .system)
    private let activity = UIActivityIndicatorView(style: .medium)

    private var currentLink: CheckoutLink?
    private var loadTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private var imageTasks: [Task<Void, Never>] = []

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
        loadSelectedCard(conversation.selectedMessage)
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        loadSelectedCard(message)
    }

    override func didResignActive(with conversation: MSConversation) {
        super.didResignActive(with: conversation)
        loadTask?.cancel()
        statusTask?.cancel()
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
    }

    private func loadSelectedCard(_ message: MSMessage?) {
        loadTask?.cancel()
        statusTask?.cancel()
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
        currentLink = nil

        guard let messageURL = message?.url else {
            renderEmptyState()
            return
        }

        do {
            let link = try CheckoutLink(
                url: messageURL,
                allowedHosts: configuredCheckoutHosts
            )
            currentLink = link
            requestPresentationStyle(.expanded)
            renderLoadingState()
            loadTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let summary = try await client.summary(for: link)
                    guard !Task.isCancelled, currentLink == link else { return }
                    render(summary)
                    startStatusPolling(for: link)
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    renderError(error.localizedDescription)
                }
            }
        } catch {
            renderError(error.localizedDescription)
        }
    }

    private var configuredCheckoutHosts: Set<String> {
        let values = Bundle.main.object(
            forInfoDictionaryKey: "TavraAllowedCheckoutHosts"
        ) as? [String] ?? []
        return Set(values)
    }

    private func startStatusPolling(for link: CheckoutLink) {
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, currentLink == link {
                do {
                    let status = try await client.status(for: link)
                    guard !Task.isCancelled, currentLink == link else { return }
                    render(status)
                    if status.isTerminal { return }
                } catch is CancellationError {
                    return
                } catch {
                    statusLabel.text = "Reconnecting to Tavra"
                    statusLabel.textColor = .secondaryLabel
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
        guard let link = currentLink else { return }
        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = false
        let safari = SFSafariViewController(
            url: link.approvalURL,
            configuration: configuration
        )
        safari.delegate = self
        safari.dismissButtonStyle = .close
        present(safari, animated: true)
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        guard let currentLink else { return }
        startStatusPolling(for: currentLink)
    }

    private func configureView() {
        view.backgroundColor = .systemGroupedBackground

        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        contentStack.axis = .vertical
        contentStack.spacing = 18
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
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 20),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -28),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -40),
        ])

        contentStack.addArrangedSubview(makeHeader())

        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0
        statusLabel.textColor = .secondaryLabel
        statusLabel.accessibilityIdentifier = "checkout-status"
        contentStack.addArrangedSubview(statusLabel)

        titleLabel.font = .systemFont(ofSize: 30, weight: .bold)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0
        contentStack.addArrangedSubview(titleLabel)

        detailLabel.font = .preferredFont(forTextStyle: .body)
        detailLabel.adjustsFontForContentSizeCategory = true
        detailLabel.numberOfLines = 0
        detailLabel.textColor = .secondaryLabel
        contentStack.addArrangedSubview(detailLabel)

        configureReviewPanel()
        contentStack.addArrangedSubview(reviewPanel)

        expirationLabel.font = .preferredFont(forTextStyle: .footnote)
        expirationLabel.adjustsFontForContentSizeCategory = true
        expirationLabel.numberOfLines = 0
        expirationLabel.textColor = .secondaryLabel
        contentStack.addArrangedSubview(expirationLabel)

        trustLabel.font = .preferredFont(forTextStyle: .footnote)
        trustLabel.adjustsFontForContentSizeCategory = true
        trustLabel.numberOfLines = 0
        trustLabel.textColor = .secondaryLabel
        trustLabel.text = "Payment opens in Prava’s protected page. Tavra never receives your card details."
        contentStack.addArrangedSubview(trustLabel)

        var buttonConfiguration = UIButton.Configuration.filled()
        buttonConfiguration.title = "Continue securely with Prava"
        buttonConfiguration.cornerStyle = .large
        buttonConfiguration.buttonSize = .large
        approveButton.configuration = buttonConfiguration
        approveButton.addTarget(self, action: #selector(continueWithPrava), for: .touchUpInside)
        approveButton.accessibilityHint = "Opens the protected Prava approval page while you remain in Messages"
        contentStack.addArrangedSubview(approveButton)

        activity.hidesWhenStopped = true
        contentStack.addArrangedSubview(activity)
    }

    private func configureReviewPanel() {
        reviewPanel.axis = .vertical
        reviewPanel.spacing = 14
        reviewPanel.isLayoutMarginsRelativeArrangement = true
        reviewPanel.directionalLayoutMargins = .init(
            top: 18,
            leading: 18,
            bottom: 18,
            trailing: 18
        )
        reviewPanel.backgroundColor = .secondarySystemGroupedBackground
        reviewPanel.layer.cornerRadius = 18
        reviewPanel.layer.cornerCurve = .continuous

        let reviewTitle = UILabel()
        reviewTitle.text = "Recovery kit"
        reviewTitle.font = .preferredFont(forTextStyle: .headline)
        reviewTitle.adjustsFontForContentSizeCategory = true

        itemCountLabel.font = .preferredFont(forTextStyle: .subheadline)
        itemCountLabel.adjustsFontForContentSizeCategory = true
        itemCountLabel.textColor = .secondaryLabel
        itemCountLabel.textAlignment = .right
        itemCountLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let reviewHeader = UIStackView(arrangedSubviews: [reviewTitle, UIView(), itemCountLabel])
        reviewHeader.axis = .horizontal
        reviewHeader.alignment = .firstBaseline
        reviewHeader.spacing = 10
        reviewPanel.addArrangedSubview(reviewHeader)
        reviewPanel.addArrangedSubview(makeSeparator())

        productsStack.axis = .vertical
        productsStack.spacing = 0
        reviewPanel.addArrangedSubview(productsStack)
        reviewPanel.addArrangedSubview(makeSeparator())

        totalCaptionLabel.text = "Total"
        totalCaptionLabel.font = .preferredFont(forTextStyle: .headline)
        totalCaptionLabel.adjustsFontForContentSizeCategory = true

        totalLabel.font = .systemFont(ofSize: 24, weight: .bold)
        totalLabel.adjustsFontForContentSizeCategory = true
        totalLabel.textAlignment = .right
        totalLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        totalLabel.accessibilityIdentifier = "checkout-total"
        let totalRow = UIStackView(arrangedSubviews: [totalCaptionLabel, UIView(), totalLabel])
        totalRow.axis = .horizontal
        totalRow.alignment = .firstBaseline
        totalRow.spacing = 10
        reviewPanel.addArrangedSubview(totalRow)
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
        mark.font = .systemFont(ofSize: 24, weight: .bold)
        mark.layer.cornerRadius = 13
        mark.layer.cornerCurve = .continuous
        mark.clipsToBounds = true
        mark.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 44),
            mark.heightAnchor.constraint(equalToConstant: 44),
        ])

        let brand = UILabel()
        brand.text = "Tavra"
        brand.font = .systemFont(ofSize: 22, weight: .semibold)
        brand.adjustsFontForContentSizeCategory = true

        let secure = UILabel()
        secure.text = "Secure approval"
        secure.textAlignment = .right
        secure.textColor = .secondaryLabel
        secure.font = .preferredFont(forTextStyle: .subheadline)
        secure.adjustsFontForContentSizeCategory = true

        let stack = UIStackView(arrangedSubviews: [mark, brand, UIView(), secure])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 12
        return stack
    }

    private func renderEmptyState() {
        activity.stopAnimating()
        setCheckoutControlsVisible(false)
        statusLabel.text = "Tavra Messages"
        statusLabel.textColor = .secondaryLabel
        titleLabel.text = "Open a Tavra checkout card."
        detailLabel.text = "Tap the Tavra card in this conversation to review its items and continue to secure approval."
        replaceProducts(with: [])
        totalLabel.text = nil
        expirationLabel.text = nil
        approveButton.isEnabled = false
    }

    private func renderLoadingState() {
        setCheckoutControlsVisible(false)
        statusLabel.text = "Loading protected checkout"
        statusLabel.textColor = .secondaryLabel
        titleLabel.text = "Reviewing your Tavra card"
        detailLabel.text = "Fetching a redacted order summary."
        replaceProducts(with: [])
        totalLabel.text = nil
        expirationLabel.text = nil
        approveButton.isEnabled = false
        activity.startAnimating()
    }

    private func renderError(_ message: String) {
        activity.stopAnimating()
        setCheckoutControlsVisible(false)
        statusLabel.text = "Unable to open checkout"
        statusLabel.textColor = .systemRed
        titleLabel.text = "This Tavra card can’t be opened."
        detailLabel.text = message
        replaceProducts(with: [])
        totalLabel.text = nil
        expirationLabel.text = nil
        approveButton.isEnabled = false
    }

    private func render(_ summary: CheckoutSummary) {
        activity.stopAnimating()
        setCheckoutControlsVisible(true)
        statusLabel.text = "Prepared, not purchased"
        statusLabel.textColor = .secondaryLabel
        titleLabel.text = "Review your recovery kit"
        detailLabel.text = summary.order.description
        replaceProducts(with: summary.order.products, currency: summary.order.currency)
        totalLabel.text = money(summary.order.totalAmount, currency: summary.order.currency)
        expirationLabel.text = expirationText(summary.expiresAt)
        approveButton.isEnabled = true
        approveButton.configuration?.title = "Continue securely with Prava"
    }

    private func setCheckoutControlsVisible(_ isVisible: Bool) {
        reviewPanel.isHidden = !isVisible
        expirationLabel.isHidden = !isVisible
        trustLabel.isHidden = !isVisible
        approveButton.isHidden = !isVisible
    }

    private func render(_ status: CheckoutPublicStatus) {
        switch status {
        case .pending:
            statusLabel.text = "Waiting for secure approval"
            statusLabel.textColor = .secondaryLabel
            approveButton.isEnabled = true
            approveButton.configuration?.title = "Continue securely with Prava"
        case .awaitingResult:
            statusLabel.text = "Approval received. Verifying the result"
            statusLabel.textColor = .systemBlue
            approveButton.isEnabled = false
            approveButton.configuration?.title = "Verifying approval"
        case let .completed(merchantOrderID, outcome):
            if outcome == .simulated {
                statusLabel.text = "Sandbox approval complete · \(merchantOrderID) · no live merchant order"
            } else {
                statusLabel.text = "Merchant order confirmed · \(merchantOrderID)"
            }
            statusLabel.textColor = .systemGreen
            approveButton.isEnabled = false
            approveButton.configuration?.title = "Approval complete"
        case let .reconciliationRequired(message):
            statusLabel.text = message
            statusLabel.textColor = .systemOrange
            approveButton.isEnabled = false
            approveButton.configuration?.title = "Approval under review"
        case let .failed(message):
            statusLabel.text = message
            statusLabel.textColor = .systemRed
            approveButton.isEnabled = false
            approveButton.configuration?.title = "Approval not completed"
        }
    }

    private func replaceProducts(
        with products: [CheckoutSummary.Order.Product],
        currency: String = "USD"
    ) {
        imageTasks.forEach { $0.cancel() }
        imageTasks.removeAll()
        for view in productsStack.arrangedSubviews {
            productsStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        productsStack.isHidden = products.isEmpty
        let totalQuantity = products.reduce(into: 0) { total, product in
            total += product.quantity
        }
        itemCountLabel.text = products.isEmpty
            ? nil
            : "\(totalQuantity) \(totalQuantity == 1 ? "item" : "items")"
        for (index, product) in products.enumerated() {
            if index > 0 {
                productsStack.addArrangedSubview(makeSeparator())
            }

            let thumbnail = UIImageView(image: UIImage(systemName: "shippingbox.fill"))
            thumbnail.contentMode = .center
            thumbnail.tintColor = .secondaryLabel
            thumbnail.backgroundColor = .tertiarySystemGroupedBackground
            thumbnail.layer.cornerRadius = 12
            thumbnail.layer.cornerCurve = .continuous
            thumbnail.clipsToBounds = true
            thumbnail.translatesAutoresizingMaskIntoConstraints = false
            thumbnail.isAccessibilityElement = false
            thumbnail.accessibilityElementsHidden = true
            thumbnail.accessibilityIdentifier = "checkout-product-image-\(index)"
            NSLayoutConstraint.activate([
                thumbnail.widthAnchor.constraint(equalToConstant: 64),
                thumbnail.heightAnchor.constraint(equalToConstant: 64),
            ])

            let name = UILabel()
            name.text = product.quantity == 1
                ? product.description
                : "\(product.quantity) × \(product.description)"
            name.font = .preferredFont(forTextStyle: .body)
            name.adjustsFontForContentSizeCategory = true
            name.numberOfLines = 0
            name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let price = UILabel()
            price.text = money(
                multipliedAmount(product.unitPrice, by: product.quantity),
                currency: currency
            )
            price.font = .systemFont(ofSize: 17, weight: .semibold)
            price.adjustsFontForContentSizeCategory = true
            price.textAlignment = .right
            price.setContentCompressionResistancePriority(.required, for: .horizontal)

            let textStack = UIStackView(arrangedSubviews: [name, price])
            textStack.axis = .horizontal
            textStack.alignment = .center
            textStack.spacing = 12

            let row = UIStackView(arrangedSubviews: [thumbnail, textStack])
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = 12
            row.isLayoutMarginsRelativeArrangement = true
            row.directionalLayoutMargins = .init(top: 3, leading: 0, bottom: 3, trailing: 0)
            row.accessibilityIdentifier = "checkout-product-\(index)"
            productsStack.addArrangedSubview(row)

            if let imageURL = product.imageUrl, let link = currentLink {
                let task = Task { [weak self, weak thumbnail] in
                    guard let self, let thumbnail else { return }
                    do {
                        let data = try await client.productImageData(at: imageURL, for: link)
                        guard !Task.isCancelled,
                              currentLink == link,
                              let image = UIImage(data: data) else { return }
                        thumbnail.image = image
                        thumbnail.contentMode = .scaleAspectFill
                        thumbnail.tintColor = nil
                    } catch {
                        // The text row remains complete if an optional thumbnail fails.
                    }
                }
                imageTasks.append(task)
            }
        }
    }

    private func multipliedAmount(_ amount: String, by quantity: Int) -> String {
        let value = NSDecimalNumber(string: amount)
            .multiplying(by: NSDecimalNumber(value: quantity))
        return value.stringValue
    }

    private func money(_ amount: String, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.locale = .current
        return formatter.string(from: NSDecimalNumber(string: amount))
            ?? "\(currency) \(amount)"
    }

    private func expirationText(_ timestamp: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: timestamp) else {
            return "This approval link expires soon."
        }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return "Secure session expires at \(formatter.string(from: date))."
    }
}

private extension CheckoutPublicStatus {
    var isTerminal: Bool {
        switch self {
        case .pending, .awaitingResult:
            false
        case .completed, .reconciliationRequired, .failed:
            true
        }
    }
}
