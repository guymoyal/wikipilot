(function () {
  var root = document.documentElement;
  // Theme is applied pre-paint by an inline <head> script; this file only
  // handles the toggle and everything downstream of it.

  /*
   * Mermaid's stock dark theme doesn't know about our palette — its default
   * edge-label background is a pale box that floats on a dark page. Feed it the
   * same tokens the rest of the wiki uses so diagrams sit in the design.
   */
  function initMermaid(mode) {
    if (!window.mermaid) return;
    var dark = mode === "dark";
    window.mermaid.initialize({
      startOnLoad: true,
      theme: dark ? "dark" : "default",
      themeVariables: dark
        ? {
            background: "#1b2027",
            primaryColor: "#1a1f26",
            primaryTextColor: "#e6ebf1",
            primaryBorderColor: "#3a434f",
            secondaryColor: "#212831",
            tertiaryColor: "#212831",
            lineColor: "#8b95a3",
            textColor: "#e6ebf1",
            edgeLabelBackground: "#1b2027",
          }
        : { edgeLabelBackground: "#f0f3f7" },
    });
  }

  function currentMode() {
    return root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }

  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = currentMode() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("wikipilot-theme", next);
      initMermaid(next);
    });
  }

  initMermaid(currentMode());

  var navToggle = document.querySelector(".nav-toggle");
  var sidebar = document.querySelector(".sidebar");
  if (navToggle && sidebar) {
    navToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = document.body.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("nav-open")) return;
      // A tap on a sidebar link navigates anyway; any tap outside closes.
      if (!sidebar.contains(e.target)) {
        document.body.classList.remove("nav-open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  var kbd = document.querySelector(".search-kbd");
  if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform || "")) {
    kbd.textContent = "Ctrl K";
  }

  var input = document.querySelector(".search-box input");
  var results = document.querySelector(".search-results");

  if (input) {
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.focus();
      }
      if (e.key === "Escape" && document.activeElement === input) {
        input.blur();
      }
    });
  }

  if (input && results && window.MiniSearch) {
    fetch(document.body.getAttribute("data-base") + "search-index.json")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var mini = window.MiniSearch.loadJSON(JSON.stringify(data.index), data.options);
        input.addEventListener("input", function () {
          var query = input.value.trim();
          if (!query) {
            results.classList.remove("open");
            results.innerHTML = "";
            return;
          }
          var hits = mini.search(query, { prefix: true, fuzzy: 0.2 }).slice(0, 8);
          // Titles come from page frontmatter, which is drafted from scanned repo
          // content — build nodes rather than concatenating them into innerHTML.
          results.replaceChildren();
          hits.forEach(function (hit) {
            var a = document.createElement("a");
            a.setAttribute("href", hit.url);
            a.textContent = hit.title;
            results.appendChild(a);
          });
          results.classList.toggle("open", hits.length > 0);
        });
        document.addEventListener("click", function (e) {
          if (!results.contains(e.target) && e.target !== input) {
            results.classList.remove("open");
          }
        });
      });
  }

  // The wiki itself is static HTML. Only the assistant talks to a server, and
  // that server can be anywhere — an absolute URL wins over the local dev port.
  var agentPort = document.body.getAttribute("data-agent-port");
  var configuredUrl = document.body.getAttribute("data-agent-url");
  if (!agentPort && !configuredUrl) return;

  var agentUrl = configuredUrl || window.location.protocol + "//" + window.location.hostname + ":" + agentPort + "/api/chat";
  var history = [];

  var fab = document.createElement("button");
  fab.className = "chat-fab";
  fab.setAttribute("aria-label", "Ask the wiki");
  // The message-circle mark from src/lib/site/icons.ts — assets ship verbatim,
  // so the path data is duplicated here; keep the two in sync.
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  document.body.appendChild(fab);

  var panel = document.createElement("div");
  panel.className = "chat-panel";
  panel.innerHTML =
    '<div class="chat-header">Ask the wiki<button class="chat-close" aria-label="Close">×</button></div>' +
    '<div class="chat-messages"></div>' +
    '<form class="chat-form"><input type="text" placeholder="Ask a question..." autocomplete="off" /><button type="submit">Send</button></form>';
  document.body.appendChild(panel);

  var messagesEl = panel.querySelector(".chat-messages");
  var formEl = panel.querySelector(".chat-form");
  var inputEl = panel.querySelector(".chat-form input");

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "chat-msg chat-msg-" + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  fab.addEventListener("click", function () {
    panel.classList.toggle("open");
  });
  panel.querySelector(".chat-close").addEventListener("click", function () {
    panel.classList.remove("open");
  });

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    var message = inputEl.value.trim();
    if (!message) return;
    inputEl.value = "";
    addMessage("user", message);
    addMessage("assistant", "…");
    var placeholder = messagesEl.lastChild;

    fetch(agentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, history: history }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        placeholder.textContent = data.answer || data.error || "No response.";
        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: data.answer || "" });
      })
      .catch(function () {
        placeholder.textContent = "Couldn't reach the AI assistant — is it running (`wikipilot agent`)?";
      });
  });
})();
