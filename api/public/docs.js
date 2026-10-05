import { typingDemo } from "./demo.js";

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const code = button.closest(".code-block")?.querySelector("code")?.textContent;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  } catch {
    button.textContent = "Failed";
    setTimeout(() => { button.textContent = "Copy"; }, 1500);
  }
});

// The top bar's search box plays the same typing demo as the home page. Tab or → takes the query and opens its chart.
const ask = document.querySelector(".topbar .ask input");
if (ask) typingDemo(ask, { take: (q) => { ask.value = q; ask.form.requestSubmit(); } }).start();
