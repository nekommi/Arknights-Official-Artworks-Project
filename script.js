(function () {
  const MAX_READER_PRELOAD = 6;
  const READER_LOADING_HIDE_DELAY_MS = 2000;

  const state = {
    books: [],
    currentBook: null,
    currentRightPage: 1,
    selectingDownloadPage: false,
    magnifierEnabled: false,
    magnifierZoom: 2.2,
    magnifierPointerX: 0,
    magnifierPointerY: 0,
    magnifierTargetImage: null,
    magnifierRaf: 0,
    readerPreloadCache: new Map(),
    readerPreloadOrder: [],
    previewBuiltForBookId: null,
    previewObserver: null,
    loadingNoticeTimer: 0,
    pendingPdfUrl: null,
    pendingZipUrl: null,
  };

  const homeView = document.getElementById("homeView");
  const readerView = document.getElementById("readerView");
  const bookGrid = document.getElementById("bookGrid");

  const spread = document.getElementById("spread");
  const leftSlot = document.getElementById("leftSlot");
  const rightSlot = document.getElementById("rightSlot");
  const magnifier = document.getElementById("magnifier");

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const pageStatus = document.getElementById("pageStatus");
  const previewBtn = document.getElementById("previewBtn");

  const backBtn = document.getElementById("backBtn");
  const downloadCurrentBtn = document.getElementById("downloadCurrentBtn");
  const magnifierBtn = document.getElementById("magnifierBtn");

  const themeToggleBtn = document.getElementById("themeToggleBtn");

  const pdfModal = document.getElementById("pdfModal");
  const cancelPdfBtn = document.getElementById("cancelPdfBtn");
  const archiveBtn = document.getElementById("archiveBtn");
  const confirmZipBtn = document.getElementById("confirmZipBtn");
  const confirmPdfBtn = document.getElementById("confirmPdfBtn");

  const previewModal = document.getElementById("previewModal");
  const closePreviewBtn = document.getElementById("closePreviewBtn");
  const previewGrid = document.getElementById("previewGrid");
  const downloadHint = document.getElementById("downloadHint");
  const readerLoadingNotice = document.getElementById("readerLoadingNotice");

  function showReaderLoadingNotice() {
    if (!readerLoadingNotice) {
      return;
    }

    if (state.loadingNoticeTimer) {
      window.clearTimeout(state.loadingNoticeTimer);
      state.loadingNoticeTimer = 0;
    }

    readerLoadingNotice.classList.remove("hidden");
  }

  function hideReaderLoadingNotice(delayMs = 0) {
    if (!readerLoadingNotice) {
      return;
    }

    if (state.loadingNoticeTimer) {
      window.clearTimeout(state.loadingNoticeTimer);
      state.loadingNoticeTimer = 0;
    }

    const hide = () => readerLoadingNotice.classList.add("hidden");
    if (delayMs > 0) {
      state.loadingNoticeTimer = window.setTimeout(() => {
        hide();
        state.loadingNoticeTimer = 0;
      }, delayMs);
      return;
    }

    hide();
  }

  function encodePath(path) {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function pageName(book, pageNumber) {
    const filePageNumber = (book.pageStart || 1) + pageNumber - 1;
    return book.pageTemplate.replace("{n}", String(filePageNumber));
  }

  function pagePath(book, pageNumber) {
    return encodePath(`${book.folder}/${pageName(book, pageNumber)}`);
  }

  function previewPagePath(book, pageNumber) {
    if (book.previewFolder) {
      return encodePath(`${book.previewFolder}/${pageName(book, pageNumber)}`);
    }
    return pagePath(book, pageNumber);
  }

  function preloadReaderPage(book, pageNumber, fetchPriority = "auto") {
    if (!book || !pageNumber || pageNumber < 1 || pageNumber > book.pageCount) {
      return null;
    }

    const sourcePath = pagePath(book, pageNumber);
    if (state.readerPreloadCache.has(sourcePath)) {
      return state.readerPreloadCache.get(sourcePath);
    }

    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.fetchPriority = fetchPriority;
    img.src = sourcePath;

    state.readerPreloadCache.set(sourcePath, img);
    state.readerPreloadOrder.push(sourcePath);

    while (state.readerPreloadOrder.length > MAX_READER_PRELOAD) {
      const oldestPath = state.readerPreloadOrder.shift();
      if (oldestPath) {
        state.readerPreloadCache.delete(oldestPath);
      }
    }

    return img;
  }

  function waitForImageReady(img) {
    if (!img) {
      return Promise.resolve();
    }

    if (img.complete && img.naturalWidth > 0) {
      if (typeof img.decode === "function") {
        return img.decode().catch(() => {});
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = () => {
        if (typeof img.decode === "function") {
          img.decode().catch(() => {}).finally(resolve);
          return;
        }
        resolve();
      };
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    });
  }

  async function ensureSpreadReady(rightPageNumber) {
    if (!state.currentBook) {
      return;
    }

    const pages = [rightPageNumber === 1 ? null : rightPageNumber - 1, rightPageNumber];
    const pending = [];

    for (const pageNumber of pages) {
      if (!pageNumber || pageNumber < 1 || pageNumber > state.currentBook.pageCount) {
        continue;
      }
      const img = preloadReaderPage(state.currentBook, pageNumber, "high");
      pending.push(waitForImageReady(img));
    }

    if (pending.length) {
      await Promise.all(pending);
    }
  }

  function preloadNearbyReaderPages() {
    if (!state.currentBook) {
      return;
    }

    const pagesToPreload = new Set();
    const current = state.currentRightPage;

    for (let offset = -2; offset <= 2; offset += 1) {
      const pageNumber = current + offset;
      if (pageNumber >= 1 && pageNumber <= state.currentBook.pageCount) {
        pagesToPreload.add(pageNumber);
      }
    }

    for (const pageNumber of pagesToPreload) {
      preloadReaderPage(state.currentBook, pageNumber, "low");
    }
  }

  function coverPath(book) {
    if (book.cover) {
      return encodePath(book.cover);
    }
    return pagePath(book, book.coverPage || 1);
  }

  function maxRightPage(book) {
    return book.pageCount % 2 === 0 ? book.pageCount + 1 : book.pageCount;
  }

  function spreadPages() {
    if (!state.currentBook) {
      return { left: null, right: null };
    }

    const right = state.currentRightPage <= state.currentBook.pageCount ? state.currentRightPage : null;
    const left = state.currentRightPage === 1 ? null : state.currentRightPage - 1;
    return { left, right };
  }

  function clearSelectionState() {
    state.selectingDownloadPage = false;
    downloadCurrentBtn.textContent = "📥";
    downloadCurrentBtn.title = "Download Current Page";
    downloadCurrentBtn.classList.remove("active");
    if (downloadHint) {
      downloadHint.classList.add("hidden");
    }

    for (const img of spread.querySelectorAll(".page-image")) {
      img.classList.remove("selectable");
      img.title = "";
    }
  }

  function setPageImage(slot, pageNumber, side) {
    slot.classList.remove("empty");
    slot.replaceChildren();

    if (!pageNumber || pageNumber > state.currentBook.pageCount) {
      slot.classList.add("empty");
      return;
    }

    const img = document.createElement("img");
    img.className = "page-image";
    img.alt = `Page ${pageNumber}`;
    const sourcePath = pagePath(state.currentBook, pageNumber);
    const cached = state.readerPreloadCache.get(sourcePath);
    img.src = cached?.src || sourcePath;
    img.loading = "eager";
    img.decoding = cached?.complete ? "sync" : "async";
    img.dataset.page = String(pageNumber);

    img.addEventListener("click", () => {
      if (!state.selectingDownloadPage) {
        if (side === "left") {
          goPrev();
        } else {
          goNext();
        }
        return;
      }
      downloadPageImage(pageNumber);
      clearSelectionState();
    });

    img.addEventListener("mousemove", (event) => queueMagnifierUpdate(event, img));
    img.addEventListener("mouseenter", () => showMagnifier(img));
    img.addEventListener("mouseleave", hideMagnifier);

    slot.appendChild(img);
  }

  function refreshPageStatus() {
    const pages = spreadPages();
    if (pages.left && pages.right) {
      pageStatus.textContent = `Pages ${pages.left}-${pages.right} / ${state.currentBook.pageCount}`;
      return;
    }

    const single = pages.right || pages.left || 1;
    pageStatus.textContent = `Page ${single} / ${state.currentBook.pageCount}`;
  }

  function refreshNavState() {
    prevBtn.disabled = state.currentRightPage <= 1;
    nextBtn.disabled = state.currentRightPage >= maxRightPage(state.currentBook);
  }

  function renderSpread() {
    const pages = spreadPages();
    setPageImage(leftSlot, pages.left, "left");
    setPageImage(rightSlot, pages.right, "right");

    if (state.selectingDownloadPage) {
      const imgs = spread.querySelectorAll(".page-image");
      for (const img of imgs) {
        img.classList.add("selectable");
        img.title = "Click to download this page image";
      }
    }

    refreshPageStatus();
    refreshNavState();
    preloadNearbyReaderPages();
  }

  function flip(direction) {
    spread.classList.remove("flip-next", "flip-prev");
    window.requestAnimationFrame(() => {
      spread.classList.add(direction === "next" ? "flip-next" : "flip-prev");
    });

    window.setTimeout(() => {
      spread.classList.remove("flip-next", "flip-prev");
    }, 360);
  }

  async function goNext() {
    const limit = maxRightPage(state.currentBook);
    if (state.currentRightPage >= limit) {
      return;
    }

    const nextRightPage = state.currentRightPage === 1 ? 3 : state.currentRightPage + 2;
    clearSelectionState();
    await ensureSpreadReady(nextRightPage);
    state.currentRightPage = nextRightPage;
    flip("next");
    renderSpread();
  }

  async function goPrev() {
    if (state.currentRightPage <= 1) {
      return;
    }

    const previousRightPage = state.currentRightPage <= 3 ? 1 : state.currentRightPage - 2;
    clearSelectionState();
    await ensureSpreadReady(previousRightPage);
    state.currentRightPage = previousRightPage;
    flip("prev");
    renderSpread();
  }

  async function goToPage(pageNumber) {
    if (!state.currentBook) {
      return;
    }

    const safe = Math.max(1, Math.min(pageNumber, state.currentBook.pageCount));
    let nextRightPage;

    if (safe === 1) {
      nextRightPage = 1;
    } else {
      nextRightPage = safe % 2 === 0 ? safe + 1 : safe;
      const limit = maxRightPage(state.currentBook);
      if (nextRightPage > limit) {
        nextRightPage = limit;
      }
    }

    clearSelectionState();
    showReaderLoadingNotice();
    await ensureSpreadReady(nextRightPage);
    if (!state.currentBook) {
      return;
    }

    state.currentRightPage = nextRightPage;
    renderSpread();
    hideReaderLoadingNotice(READER_LOADING_HIDE_DELAY_MS);
  }

  async function openReader(book) {
    state.currentBook = book;
    state.currentRightPage = 1;
    state.previewBuiltForBookId = null;
    previewGrid.innerHTML = "";
    state.magnifierEnabled = false;
    state.magnifierZoom = 2.2;
    document.body.classList.remove("magnifier-on");
    hideMagnifier();
    magnifierBtn.textContent = "🔍";
    magnifierBtn.classList.remove("active");
    magnifierBtn.title = "Toggle Magnifier";

    homeView.classList.add("hidden");
    readerView.classList.remove("hidden");
    document.body.classList.add("reading");
    showReaderLoadingNotice();

    renderSpread();

    await ensureSpreadReady(1);
    if (state.currentBook === book) {
      hideReaderLoadingNotice(READER_LOADING_HIDE_DELAY_MS);
    }
  }

  function openHome() {
    clearSelectionState();
    state.currentBook = null;
    state.previewBuiltForBookId = null;
    state.previewObserver?.disconnect();
    previewGrid.innerHTML = "";
    state.readerPreloadCache.clear();
    state.readerPreloadOrder.length = 0;
    readerView.classList.add("hidden");
    homeView.classList.remove("hidden");
    document.body.classList.remove("reading");
    document.body.classList.remove("magnifier-on");
    hideMagnifier();
    hideReaderLoadingNotice();
  }

  function openPdfWarning(pdfUrl, archiveUrl, zipUrl) {
    state.pendingPdfUrl = pdfUrl;
    state.pendingArchiveUrl = archiveUrl;
    state.pendingZipUrl = zipUrl;
    pdfModal.classList.remove("hidden");
  }

  function closePdfWarning() {
    state.pendingPdfUrl = null;
    state.pendingArchiveUrl = null;
    state.pendingZipUrl = null;
    pdfModal.classList.add("hidden");
  }

  function triggerPdfDownload() {
    if (!state.pendingPdfUrl) {
      return;
    }

    const a = document.createElement("a");
    a.href = state.pendingPdfUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    closePdfWarning();
  }

  function triggerZipDownload() {
    if (!state.pendingZipUrl) {
      return;
    }

    const a = document.createElement("a");
    a.href = state.pendingZipUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    closePdfWarning();
  }

  function startDownloadCurrentPageFlow() {
    if (state.selectingDownloadPage) {
      clearSelectionState();
      return;
    }

    const images = spread.querySelectorAll(".page-image");
    if (!images.length) {
      return;
    }

    state.selectingDownloadPage = true;
    downloadCurrentBtn.textContent = "✕";
    downloadCurrentBtn.title = "Cancel Download Selection";
    downloadCurrentBtn.classList.add("active");
    if (downloadHint) {
      downloadHint.classList.remove("hidden");
    }

    for (const img of images) {
      img.classList.add("selectable");
      img.title = "Click to download this page image";
    }
  }

  function downloadPageImage(pageNumber) {
    const sourceUrl = pagePath(state.currentBook, pageNumber);
    const webpName = `${state.currentBook.title} - Page ${pageNumber}.webp`;
    const a = document.createElement("a");
    a.href = sourceUrl;
    a.download = webpName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openPreview() {
    if (!state.currentBook) {
      return;
    }

    if (state.previewBuiltForBookId !== state.currentBook.id) {
      previewGrid.replaceChildren();
      const fragment = document.createDocumentFragment();

      for (let page = 1; page <= state.currentBook.pageCount; page += 1) {
        const item = document.createElement("button");
        item.className = "preview-item";
        item.type = "button";

        const img = document.createElement("img");
        img.className = "preview-thumb loading";
        img.dataset.src = previewPagePath(state.currentBook, page);
        img.alt = `Page ${page}`;
        img.loading = "lazy";
        img.decoding = "async";

        const clearLoading = () => img.classList.remove("loading");
        img.addEventListener("load", clearLoading, { once: true });
        img.addEventListener("error", clearLoading, { once: true });

        const label = document.createElement("div");
        label.textContent = `Page ${page}`;

        item.appendChild(img);
        item.appendChild(label);
        item.addEventListener("click", async () => {
          closePreview();
          await goToPage(page);
        });

        fragment.appendChild(item);
      }

      previewGrid.appendChild(fragment);
      state.previewBuiltForBookId = state.currentBook.id;
    }

    previewGrid.scrollTop = 0;

    previewModal.classList.remove("hidden");
    observePreviewImages();
  }

  function closePreview() {
    previewModal.classList.add("hidden");
    state.previewObserver?.disconnect();
  }

  function createPreviewObserver() {
    if (state.previewObserver) {
      return state.previewObserver;
    }

    if (!("IntersectionObserver" in window)) {
      return null;
    }

    state.previewObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          const img = entry.target;
          const src = img.dataset.src;
          if (src && !img.src) {
            img.src = src;
            img.fetchPriority = "low";
          }
          observer.unobserve(img);
        }
      },
      {
        root: previewGrid,
        rootMargin: "300px 0px",
        threshold: 0.01,
      }
    );

    return state.previewObserver;
  }

  function observePreviewImages() {
    const images = previewGrid.querySelectorAll("img[data-src]");
    if (!images.length) {
      return;
    }

    const observer = createPreviewObserver();
    if (!observer) {
      for (const img of images) {
        if (!img.src) {
          img.src = img.dataset.src;
          img.fetchPriority = "low";
        }
      }
      return;
    }

    for (const img of images) {
      if (!img.src) {
        observer.observe(img);
      }
    }
  }

  function showMagnifier(img) {
    if (!state.magnifierEnabled) {
      return;
    }
    state.magnifierTargetImage = img;
    magnifier.classList.remove("hidden");
    if (magnifier.dataset.source !== img.src) {
      magnifier.style.backgroundImage = `url("${img.src}")`;
      magnifier.dataset.source = img.src;
    }
  }

  function hideMagnifier() {
    magnifier.classList.add("hidden");
    state.magnifierTargetImage = null;
    if (state.magnifierRaf) {
      window.cancelAnimationFrame(state.magnifierRaf);
      state.magnifierRaf = 0;
    }
  }

  function queueMagnifierUpdate(event, img) {
    if (!state.magnifierEnabled) {
      return;
    }

    state.magnifierPointerX = event.clientX;
    state.magnifierPointerY = event.clientY;
    state.magnifierTargetImage = img;

    if (state.magnifierRaf) {
      return;
    }

    state.magnifierRaf = window.requestAnimationFrame(() => {
      state.magnifierRaf = 0;
      renderMagnifier();
    });
  }

  function renderMagnifier() {
    if (!state.magnifierEnabled || !state.magnifierTargetImage) {
      return;
    }

    const img = state.magnifierTargetImage;
    if (magnifier.dataset.source !== img.src) {
      magnifier.style.backgroundImage = `url("${img.src}")`;
      magnifier.dataset.source = img.src;
    }

    const zoom = state.magnifierZoom;
    const rect = img.getBoundingClientRect();
    const x = state.magnifierPointerX - rect.left;
    const y = state.magnifierPointerY - rect.top;

    const spreadRect = spread.getBoundingClientRect();
    const lensSize = magnifier.offsetWidth || 350;
    const lensX = state.magnifierPointerX - spreadRect.left - lensSize / 2;
    const lensY = state.magnifierPointerY - spreadRect.top - lensSize / 2;

    magnifier.style.transform = `translate(${lensX}px, ${lensY}px)`;

    const bgX = -(x * zoom - lensSize / 2);
    const bgY = -(y * zoom - lensSize / 2);
    magnifier.style.backgroundSize = `${rect.width * zoom}px ${rect.height * zoom}px`;
    magnifier.style.backgroundPosition = `${bgX}px ${bgY}px`;
  }

  function adjustMagnifierZoom(event) {
    if (!state.magnifierEnabled) {
      return;
    }

    const onPageImage = event.target && event.target.classList && event.target.classList.contains("page-image");
    if (!onPageImage) {
      return;
    }

    event.preventDefault();

    const delta = event.deltaY < 0 ? 0.15 : -0.15;
    const minZoom = 1.2;
    const maxZoom = 12;
    state.magnifierZoom = Math.max(minZoom, Math.min(maxZoom, state.magnifierZoom + delta));

    queueMagnifierUpdate(event, event.target);
  }

  function toggleMagnifier() {
    state.magnifierEnabled = !state.magnifierEnabled;
    document.body.classList.toggle("magnifier-on", state.magnifierEnabled);
    magnifierBtn.textContent = state.magnifierEnabled ? "🔎" : "🔍";
    magnifierBtn.classList.toggle("active", state.magnifierEnabled);
    magnifierBtn.title = state.magnifierEnabled ? "Magnifier ON" : "Toggle Magnifier";
    if (!state.magnifierEnabled) {
      hideMagnifier();
      state.magnifierZoom = 2.2;
    }
  }

  function renderBookCards() {
    bookGrid.innerHTML = "";
    const fragment = document.createDocumentFragment();

    for (const book of state.books) {
      const card = document.createElement("article");
      card.className = "book-card";

      const coverBtn = document.createElement("button");
      coverBtn.type = "button";
      coverBtn.className = "book-cover-btn";
      coverBtn.addEventListener("click", () => openReader(book));

      const cover = document.createElement("img");
      cover.className = "book-cover";
      cover.alt = `${book.title} cover`;
      cover.src = coverPath(book);
      cover.loading = "lazy";
      cover.decoding = "async";

      const title = document.createElement("h2");
      title.className = "book-title";
      title.textContent = book.title;

      const pdfButton = document.createElement("button");
      pdfButton.type = "button";
      pdfButton.className = "primary-btn";
      pdfButton.textContent = "Download";
      pdfButton.addEventListener("click", () => {
        openPdfWarning(encodePath(book.pdf), book.archive, encodePath(book.zip));
      });

      coverBtn.appendChild(cover);
      card.appendChild(coverBtn);
      card.appendChild(title);
      card.appendChild(pdfButton);
      fragment.appendChild(card);
    }

    bookGrid.appendChild(fragment);
  }

  async function init() {
    try {
      const response = await fetch("books.json", { cache: "default" });
      if (!response.ok) {
        throw new Error("Failed to read books.json");
      }

      const data = await response.json();
      if (!data.books || !Array.isArray(data.books)) {
        throw new Error("books.json must contain a books array.");
      }

      state.books = data.books;
      renderBookCards();
    } catch (error) {
      bookGrid.innerHTML = `<p>Could not load book data: ${String(error.message || error)}</p>`;
    }
  }

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      themeToggleBtn.textContent = "☀️";
      themeToggleBtn.title = "Switch to Dark Mode";
    } else {
      document.documentElement.removeAttribute("data-theme");
      themeToggleBtn.textContent = "🌙";
      themeToggleBtn.title = "Switch to Light Mode";
    }
    localStorage.setItem("theme", theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "light" ? "dark" : "light");
  }

  const savedTheme = localStorage.getItem("theme") || "dark";
  applyTheme(savedTheme);

  themeToggleBtn.addEventListener("click", toggleTheme);

  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", goNext);
  backBtn.addEventListener("click", openHome);
  downloadCurrentBtn.addEventListener("click", startDownloadCurrentPageFlow);
  previewBtn.addEventListener("click", openPreview);
  closePreviewBtn.addEventListener("click", closePreview);
  magnifierBtn.addEventListener("click", toggleMagnifier);
  spread.addEventListener("wheel", adjustMagnifierZoom, { passive: false });

  cancelPdfBtn.addEventListener("click", closePdfWarning);
  archiveBtn.addEventListener("click", () => {
    if (state.pendingArchiveUrl) {
      window.open(state.pendingArchiveUrl, "_blank");
      closePdfWarning();
    }
  });
  confirmPdfBtn.addEventListener("click", triggerPdfDownload);
  if (confirmZipBtn) {
    confirmZipBtn.addEventListener("click", triggerZipDownload);
  }

  pdfModal.addEventListener("click", (event) => {
    if (event.target === pdfModal) {
      closePdfWarning();
    }
  });

  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) {
      closePreview();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (readerView.classList.contains("hidden")) {
      return;
    }

    if (event.key === "ArrowRight") {
      goNext();
    } else if (event.key === "ArrowLeft") {
      goPrev();
    } else if (event.key.toLowerCase() === "escape") {
      closePreview();
      closePdfWarning();
    }
  });

  init();
})();
