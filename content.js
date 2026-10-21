(() => {
  const PULLS_PATH = /^\/[^/]+\/[^/]+\/pulls\/?$/;
  const LIST_SELECTOR = 'ul[data-listview-component="items-list"]';
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    chevron:
      "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
  };

  const STORAGE_KEY = "prstackRefs";
  const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 3000;

  // hovercard url -> {base, head, t}. Persisted so a reload can group rows before any fetch returns.
  let refs = new Map();
  // Hovercards re-checked during the current view of the list. Cached refs are shown first,
  // then every PR is re-checked once per view so base-branch changes show up.
  let checked = new Set();
  let checkedFor = "";
  const expanded = new Set(); // root PR numbers the user expanded
  let enabled = true;
  let ready = false;

  function fetchRefs(hovercardUrl) {
    return fetch(hovercardUrl, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const nodes = [...doc.querySelectorAll(".commit-ref")];
        const base = nodes.find((e) => e.classList.contains("base-ref"));
        const head = nodes.find((e) => !e.classList.contains("base-ref"));
        return { base: base?.textContent.trim(), head: head?.textContent.trim() };
      });
  }

  let saveTimer;
  function saveRefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const now = Date.now();
      const entries = [...refs].filter(([, v]) => now - v.t < KEEP_MS);
      entries.sort((a, b) => b[1].t - a[1].t);
      chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(entries.slice(0, MAX_ENTRIES)) });
    }, 1000);
  }

  function refresh(items) {
    if (checkedFor !== location.href) {
      checked = new Set();
      checkedFor = location.href;
    }
    for (const item of items) {
      if (checked.has(item.hovercard)) continue;
      checked.add(item.hovercard);
      fetchRefs(item.hovercard)
        .then((value) => {
          const old = refs.get(item.hovercard);
          refs.set(item.hovercard, { ...value, t: Date.now() });
          saveRefs();
          if (old?.base !== value.base || old?.head !== value.head) schedule();
        })
        .catch(() => {});
    }
  }

  function collectItems(list) {
    const items = [];
    for (const li of list.children) {
      const link = li.querySelector('a[data-testid="listitem-title-link"][data-hovercard-type="pull_request"]');
      const number = link?.getAttribute("href")?.match(/\/pull\/(\d+)/)?.[1];
      if (number) {
        items.push({
          li,
          number,
          href: link.getAttribute("href"),
          title: link.textContent.trim(),
          hovercard: link.dataset.hovercardUrl,
        });
      }
    }
    return items;
  }

  // Returns stacks of 2+ PRs, each ordered from the PR nearest the trunk upward.
  function buildStacks(items) {
    const byHead = new Map(items.filter((i) => i.head).map((i) => [i.head, i]));
    const children = new Map();
    const hasParent = new Set();
    for (const item of items) {
      const parent = item.base && byHead.get(item.base);
      if (parent && parent !== item) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(item);
        hasParent.add(item);
      }
    }
    const stacks = [];
    for (const root of items) {
      if (hasParent.has(root) || !children.has(root)) continue;
      const stack = [];
      const walk = (node) => {
        stack.push(node);
        for (const child of children.get(node) || []) walk(child);
      };
      walk(root);
      stacks.push(stack);
    }
    return stacks;
  }

  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function toggle(rootNumber) {
    if (expanded.has(rootNumber)) expanded.delete(rootNumber);
    else expanded.add(rootNumber);
    schedule();
  }

  function onToggleClick(rootNumber) {
    return (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle(rootNumber);
    };
  }

  // The "#123 opened by ..." line.
  function metaLine(li) {
    return li.querySelector('[data-testid="timestamp-container"]')?.parentElement;
  }

  function decorateRoot(root, stack, isOpen) {
    const li = root.li;
    li.setAttribute("data-prstack", "root");
    li.toggleAttribute("data-prstack-open", isOpen);
    li.removeAttribute("data-prstack-hidden");
    li.removeAttribute("data-prstack-last");
    li.querySelector(".prstack-position")?.remove();

    const titleContainer = li.querySelector("[data-listview-item-title-container]");
    if (titleContainer && !titleContainer.querySelector(".prstack-chevron")) {
      const chevron = el("button", "prstack-chevron");
      chevron.type = "button";
      chevron.appendChild(icon("chevron", 16));
      chevron.addEventListener("click", onToggleClick(root.number));
      titleContainer.prepend(chevron);
    }
    const meta = metaLine(li);
    const chevron = li.querySelector(".prstack-chevron");
    chevron?.setAttribute("aria-expanded", String(isOpen));
    chevron?.setAttribute("aria-label", `${isOpen ? "Collapse" : "Expand"} stack of ${stack.length} pull requests`);

    const signature = stack.map((s) => s.number).join(",");
    let chain = li.querySelector(".prstack-chain");
    if (chain && chain.dataset.signature !== signature) {
      chain.remove();
      chain = null;
    }
    if (!chain && meta) {
      chain = el("div", "prstack-chain");
      chain.dataset.signature = signature;
      stack.slice(1).forEach((member, i) => {
        if (i > 0) chain.appendChild(el("span", "prstack-chain-sep", "›"));
        const link = el("a", "prstack-chain-item");
        link.href = member.href;
        link.title = member.title;
        link.append(el("span", "prstack-chain-number", `#${member.number}`), el("span", "prstack-chain-title", member.title));
        chain.appendChild(link);
      });
      chain.prepend(el("span", "prstack-chain-lead", "Stacked on top:"));
      meta.appendChild(chain);
    }
  }

  function decorateMember(member, position, total, isLast, isOpen) {
    const li = member.li;
    li.setAttribute("data-prstack", "member");
    li.toggleAttribute("data-prstack-last", isLast);
    li.toggleAttribute("data-prstack-hidden", !isOpen);
    li.removeAttribute("data-prstack-open");
    li.querySelectorAll(".prstack-chevron, .prstack-chain").forEach((n) => n.remove());

    const titleContainer = li.querySelector("[data-listview-item-title-container]");
    let badge = li.querySelector(".prstack-position");
    if (!badge && titleContainer) {
      badge = el("span", "prstack-position");
      titleContainer.prepend(badge);
    }
    const text = `${position}/${total}`;
    if (badge && badge.textContent !== text) badge.textContent = text;
  }

  function clearItem(li) {
    for (const attr of ["data-prstack", "data-prstack-hidden", "data-prstack-open", "data-prstack-last"]) {
      li.removeAttribute(attr);
    }
    li.style.order = "";
    li.querySelectorAll(".prstack-chevron, .prstack-chain, .prstack-position").forEach((n) => n.remove());
  }

  function teardown() {
    const list = document.querySelector(LIST_SELECTOR);
    if (!list) return;
    list.removeAttribute("data-prstack-list");
    for (const li of list.children) clearItem(li);
  }

  function apply(list, items, stacks) {
    const stackOf = new Map();
    for (const stack of stacks) for (const item of stack) stackOf.set(item, stack);

    list.setAttribute("data-prstack-list", "");
    let order = 0;
    const placed = new Set();
    for (const item of items) {
      if (placed.has(item)) continue;
      const stack = stackOf.get(item);
      if (!stack) {
        clearItem(item.li);
        item.li.style.order = order++;
        placed.add(item);
        continue;
      }
      const root = stack[0];
      const isOpen = expanded.has(root.number);
      stack.forEach((member, i) => {
        placed.add(member);
        member.li.style.order = order++;
        if (i === 0) decorateRoot(root, stack, isOpen);
        else decorateMember(member, i + 1, stack.length, i === stack.length - 1, isOpen);
      });
    }
  }

  function run() {
    if (!ready || !enabled || !PULLS_PATH.test(location.pathname)) return;
    const list = document.querySelector(LIST_SELECTOR);
    if (!list) return;
    const items = collectItems(list);
    for (const item of items) Object.assign(item, refs.get(item.hovercard));
    apply(list, items, buildStacks(items));
    refresh(items);
  }

  // Batch DOM changes into one pass per frame. rAF runs before paint, so grouping from
  // cached refs lands in the same frame the list first renders.
  let frame = 0;
  function schedule() {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        run();
      });
    }
  }

  Promise.all([
    chrome.storage.sync.get({ enabled: true }),
    chrome.storage.local.get({ [STORAGE_KEY]: {} }),
  ]).then(([settings, local]) => {
    enabled = settings.enabled;
    refs = new Map(Object.entries(local[STORAGE_KEY]));
    ready = true;
    schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !("enabled" in changes)) return;
    enabled = changes.enabled.newValue !== false;
    if (enabled) schedule();
    else teardown();
  });

  // A base branch may have been changed in another tab while this one was hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkedFor = "";
      schedule();
    }
  });

  // GitHub navigates client-side and re-renders the list, so watch the DOM.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
