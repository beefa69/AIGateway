// Light/dark theme. Loaded in <head> so the saved theme applies before the page paints.
// Light is the default. The choice is remembered per browser.
(function () {
  const KEY = "theme";
  const root = document.documentElement;
  let theme = "light";
  try { theme = localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch {}
  root.dataset.theme = theme;

  function label(btn) {
    const dark = root.dataset.theme === "dark";
    btn.textContent = dark ? "☀ Light" : "☾ Dark";
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const nav = document.querySelector("body > header nav");
    if (!nav) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    label(btn);
    btn.onclick = () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, root.dataset.theme); } catch {}
      label(btn);
      document.dispatchEvent(new CustomEvent("themechange"));
    };
    nav.appendChild(btn);
  });
})();
