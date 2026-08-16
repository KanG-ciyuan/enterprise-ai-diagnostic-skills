document.documentElement.classList.add("js-enabled");

const flowButtons = Array.from(document.querySelectorAll("[data-flow-target]"));
const flowPanels = Array.from(document.querySelectorAll("[data-flow-panel]"));
const printButton = document.querySelector("[data-print]");
const navLinks = Array.from(document.querySelectorAll(".page-nav a"));

function selectFlow(panelId, moveFocus = false) {
  flowButtons.forEach((button) => {
    const selected = button.dataset.flowTarget === panelId;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });

  flowPanels.forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });

  if (moveFocus) {
    const panel = document.getElementById(panelId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }
}

function initialFlowId() {
  return window.location.hash === "#target-flow" ? "target-flow" : "current-flow";
}

flowPanels.forEach((panel) => {
  panel.setAttribute("role", "tabpanel");
  panel.tabIndex = -1;
});

flowButtons.forEach((button, index) => {
  button.addEventListener("click", () => {
    selectFlow(button.dataset.flowTarget, true);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + flowButtons.length) % flowButtons.length;
    const nextButton = flowButtons[nextIndex];
    selectFlow(nextButton.dataset.flowTarget, true);
    nextButton.focus();
  });
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    const targetId = link.getAttribute("href")?.slice(1);
    if (targetId === "current-flow" || targetId === "target-flow") {
      selectFlow(targetId, false);
    }
  });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting && !entry.target.hidden)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => {
        const active = link.getAttribute("href") === `#${visible.target.id}`;
        link.classList.toggle("is-active", active);
        if (active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    },
    { rootMargin: "-15% 0px -65%", threshold: [0.05, 0.3] },
  );

  document.querySelectorAll("main > section").forEach((section) => observer.observe(section));
}

printButton?.addEventListener("click", () => window.print());
window.addEventListener("hashchange", () => selectFlow(initialFlowId(), false));

selectFlow(initialFlowId(), false);
