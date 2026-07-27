(function () {
  var root = document.documentElement;
  var stored = localStorage.getItem("wikipilot-theme");
  if (stored) root.setAttribute("data-theme", stored);

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
  fab.textContent = "💬";
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
