import "./landing.css";

const page = document.querySelector<HTMLElement>(".landing-page");
if (!page) throw new Error("Missing landing page root");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const nav = document.querySelector<HTMLElement>(".site-nav");
const navToggle = document.querySelector<HTMLButtonElement>(".nav-toggle");
const spotlight = document.querySelector<HTMLElement>(".landing-page");
const phone = document.querySelector<HTMLElement>("[data-phone]");
const workflow = document.querySelector<HTMLElement>("[data-workflow]");

function setMenu(open: boolean): void {
  nav?.classList.toggle("is-open", open);
  navToggle?.setAttribute("aria-expanded", String(open));
}

navToggle?.addEventListener("click", () => {
  setMenu(!nav?.classList.contains("is-open"));
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => setMenu(false));
});

if (!reduceMotion.matches && spotlight) {
  window.addEventListener("pointermove", (event) => {
    spotlight.style.setProperty("--pointer-x", `${event.clientX}px`);
    spotlight.style.setProperty("--pointer-y", `${event.clientY}px`);
  }, { passive: true });
}

const revealItems = document.querySelectorAll<HTMLElement>("[data-reveal]");
if (reduceMotion.matches || !("IntersectionObserver" in window)) {
  revealItems.forEach((element) => element.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14, rootMargin: "0px 0px -36px" });
  revealItems.forEach((element) => revealObserver.observe(element));
}

if (!reduceMotion.matches) {
  document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((element) => {
    element.addEventListener("pointermove", (event) => {
      const bounds = element.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      element.style.setProperty("--tilt-x", `${(x * 3.5).toFixed(2)}deg`);
      element.style.setProperty("--tilt-y", `${(y * -3.5).toFixed(2)}deg`);
    });
    element.addEventListener("pointerleave", () => {
      element.style.setProperty("--tilt-x", "0deg");
      element.style.setProperty("--tilt-y", "0deg");
    });
  });
}

if (phone && !reduceMotion.matches) {
  let phoneFrame = 0;
  phone.addEventListener("pointermove", (event) => {
    const bounds = phone.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    cancelAnimationFrame(phoneFrame);
    phoneFrame = requestAnimationFrame(() => {
      phone.style.setProperty("--phone-x", `${(x * 2.2).toFixed(2)}deg`);
      phone.style.setProperty("--phone-y", `${(y * -2.2).toFixed(2)}deg`);
    });
  });
  phone.addEventListener("pointerleave", () => {
    phone.style.setProperty("--phone-x", "0deg");
    phone.style.setProperty("--phone-y", "0deg");
  });
}

if (workflow && !reduceMotion.matches) {
  const nodes = [...workflow.querySelectorAll<HTMLElement>("[data-workflow-node]")];
  let active = 0;
  const cycle = () => {
    nodes.forEach((node, index) => node.classList.toggle("is-active", index === active));
    active = (active + 1) % nodes.length;
  };
  cycle();
  window.setInterval(cycle, 2200);
}

document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const targetId = link.getAttribute("href");
    if (!targetId || targetId === "#") return;
    const target = document.querySelector<HTMLElement>(targetId);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
  });
});
