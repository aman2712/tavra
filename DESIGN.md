---
name: Tavra Secure Approval
description: A calm, phone-first handoff from human travel support to protected payment approval.
colors:
  canvas: "oklch(97.8% 0.008 88)"
  surface: "oklch(99.2% 0.004 88)"
  surface-muted: "oklch(95.5% 0.008 88)"
  ink: "oklch(25% 0.012 85)"
  ink-soft: "oklch(49% 0.012 85)"
  line: "oklch(89% 0.009 88)"
  approval-blue: "oklch(58% 0.19 255)"
  approval-blue-soft: "oklch(94% 0.035 255)"
  assured-green: "oklch(54% 0.105 160)"
  assured-green-soft: "oklch(94% 0.03 160)"
  recovery-red: "oklch(52% 0.16 25)"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, sans-serif"
    fontSize: "clamp(2rem, 5vw, 2.65rem)"
    fontWeight: 660
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 660
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 660
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, sans-serif"
    fontSize: "0.73rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.09em"
rounded:
  brand-mark: "9px"
  control: "12px"
  frame: "20px"
  shell: "30px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  section: "48px"
  spacious: "64px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  button-quiet:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
  checkout-shell:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.shell}"
    padding: "0"
  status-chip:
    backgroundColor: "{colors.assured-green-soft}"
    textColor: "{colors.assured-green}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 9px"
  secure-frame:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.frame}"
    padding: "0"
---

# Design System: Tavra Secure Approval

## Overview

**Creative North Star: "The Quiet Wallet Handoff"**

Tavra feels like a calm handoff from a thoughtful person in Messages to a protected Apple Wallet-like approval surface. The employee is likely moving through an airport, stressed and using one hand, so the interface is bright, low-density, immediately legible, and centered on one security-sensitive action.

The system uses generous warm space, disciplined hierarchy, and a single cool approval accent. It explicitly rejects a dense enterprise dashboard, a generic chatbot transcript, a crypto wallet, and a conventional multi-step checkout full of forms and buttons. Payment mechanics recede until they are necessary, while authorization state remains unambiguous.

**Key Characteristics:**

- Warm, light, restrained surfaces for reliable use in bright public spaces.
- One dominant checkout shell with an asymmetric summary and approval split.
- Human language before technical status, with known information already filled.
- Strong truth boundaries between prepared, approved, and purchased states.
- Responsive behavior that becomes a direct edge-to-edge mobile flow below 520px.

## Colors

The palette is a warm paper field with one measured approval blue and a quiet assured green. Color never competes with the payment decision.

### Primary

- **Clear Approval Blue:** The only interactive accent, reserved for active and focused secure fields.
- **Whispered Approval Blue:** A low-chroma state wash behind active validation labels.

### Secondary

- **Assured Green:** Confirms eligibility and completed secure approval without suggesting that a merchant purchase occurred.
- **Soft Assurance:** Supports positive chips and completion icons with low visual weight.

### Neutral

- **Travel Paper:** The page canvas, warm enough to avoid sterile checkout white.
- **Protected Surface:** The clean approval surface and iframe host.
- **Quiet Compartment:** The summary panel, skeletons, and quiet controls.
- **Charcoal Ink:** Headlines, totals, primary controls, and the Tavra mark.
- **Soft Ink:** Supporting copy, timer text, footer copy, and secondary controls.
- **Hairline Sand:** Structural borders and dividers only.
- **Recovery Red:** Errors and expired states, never decorative emphasis.

### Named Rules

**The One Cool Signal Rule.** Approval blue is used only for interaction and focus. It never becomes a decorative field or background.

**The Warm Canvas Rule.** Pure white and pure black are forbidden. Every neutral carries a slight warm tint.

## Typography

**Display Font:** Apple system sans with BlinkMacSystemFont, SF Pro Text, Segoe UI, and sans-serif fallbacks  
**Body Font:** Apple system sans with the same platform-native fallbacks  
**Label Font:** Apple system sans with the same platform-native fallbacks

**Character:** Native typography makes the approval feel familiar on an iPhone while precise tracking and weight create polish. The display voice is calm and compact; body copy is candid and easy to scan.

### Hierarchy

- **Display:** Weight 660 with tight tracking and a responsive 2rem to 2.65rem size. Use once for the primary assurance statement.
- **Headline:** Weight 660 at 1.45rem. Use for error and success outcomes.
- **Title:** Weight 660 at 1.15rem. Use for order and payment section headings.
- **Body:** Regular at 1rem with 1.55 line height. Keep explanatory lines under 65 characters where layout permits.
- **Label:** Weight 700 at 0.73rem with wide tracking and uppercase treatment. Use only for compact orientation labels.

### Named Rules

**The Native Confidence Rule.** Use the platform system stack. Do not introduce novelty typography into a high-trust payment moment.

## Elevation

Tavra is flat by default and uses tonal layering for most separation. One diffuse ambient shadow lifts the desktop checkout shell from the warm canvas; mobile removes it entirely so the flow feels native and direct.

### Shadow Vocabulary

- **Ambient Checkout Lift:** A wide, low-opacity warm shadow used only on the main desktop checkout shell.

### Named Rules

**The One Lift Rule.** Only the complete checkout shell may float. Controls, chips, order rows, and the secure frame remain flat.

## Components

### Buttons

- **Shape:** Gently rounded control corners using the control radius, with a 44px minimum height.
- **Primary:** Charcoal Ink on Protected Surface for the single recovery action in an error state.
- **Hover / Focus:** A restrained tonal darkening, a visible approval-blue focus ring, and a 0.98 active scale. Never move layout.
- **Quiet:** Quiet Compartment background with Soft Ink text for canceling the approval.

### Chips

- **Style:** Compact pills use soft tonal fills and never rely on color alone.
- **State:** Field labels move from neutral to approval blue while active, then to assured green when valid.

### Cards / Containers

- **Corner Style:** The main shell uses a generous 30px radius on desktop, 24px on tablet, and no radius on narrow phones.
- **Background:** Protected Surface for payment, Quiet Compartment for the recovery summary.
- **Shadow Strategy:** Only the main desktop shell uses Ambient Checkout Lift.
- **Border:** One Hairline Sand border around the shell and protected iframe host.
- **Internal Padding:** Spacious on desktop, then progressively reduced to 20px on narrow phones.

### Inputs / Fields

- **Style:** Prava owns the card fields inside a protected iframe. Tavra supplies a clean surface, 20px host radius, and a minimum 490px frame height.
- **Focus:** Prava receives Clear Approval Blue as the focus border color.
- **Error / Disabled:** Recovery Red marks errors, paired with an icon, heading, plain-language explanation, and recovery action.

### Navigation

- **Style:** A compact top bar contains only the Tavra wordmark and a secure-approval label. It has no menu, secondary routes, or promotional content.

### Secure Approval Shell

The signature component pairs a quiet order summary with the live Prava approval frame. It loads immediately from the iMessage link, announces state changes semantically, shows the remaining secure-session time, and gives cancellation equal clarity without competing with completion.

## Do's and Don'ts

### Do:

- **Do** keep the employee in iMessage until protected card or passkey interaction is required.
- **Do** put known order details on screen before the Prava frame appears.
- **Do** use a visible focus ring, semantic live regions, 44px controls, and reduced-motion fallbacks.
- **Do** state separately whether an option is prepared, approval is complete, and a merchant order exists.
- **Do** preserve the warm neutral canvas and restrained one-accent strategy.

### Don't:

- **Don't** resemble a dense enterprise dashboard.
- **Don't** resemble a generic chatbot transcript.
- **Don't** resemble a crypto wallet.
- **Don't** build a conventional multi-step checkout full of forms and buttons.
- **Don't** use cluttered summaries, decorative fintech effects, aggressive urgency, or technical payment terminology.
- **Don't** make the employee re-enter known information.
- **Don't** use gradients, glassmorphism, gradient text, decorative side-stripe borders, or identical card grids.
- **Don't** claim the employee is covered or that a purchase happened when Prava has only completed secure approval.
