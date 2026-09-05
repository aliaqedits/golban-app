/* =========================================================
   گل‌بان — Plant care manager
   Vanilla JS, no build step. Data lives in localStorage.
   ========================================================= */
(function () {
  "use strict";

  // ---------- Storage helpers ----------
  const PLANTS_KEY = "golban_plants_v1";
  const SETTINGS_KEY = "golban_settings_v1";

  function loadPlants() {
    try {
      return JSON.parse(localStorage.getItem(PLANTS_KEY)) || [];
    } catch (e) {
      return [];
    }
  }
  function savePlants(plants) {
    localStorage.setItem(PLANTS_KEY, JSON.stringify(plants));
  }
  function loadSettings() {
    try {
      return (
        JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {
          provider: "gemini",
          geminiKey: "",
          geminiModel: "gemini-3.5-flash-lite",
          openaiKey: "",
          openaiModel: "gpt-4o-mini",
        }
      );
    } catch (e) {
      return { provider: "gemini", geminiKey: "", geminiModel: "gemini-3.5-flash-lite", openaiKey: "", openaiModel: "gpt-4o-mini" };
    }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  let plants = loadPlants();
  let currentFilter = "all";
  let currentSearch = "";
  let pendingPhotoData = null; // base64 data URL of the resized upload
  let activeDetailId = null;

  // ---------- Utils ----------
  function uid() {
    return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function todayISO() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  function faDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
      return iso;
    }
  }
  function faNum(n) {
    return Number(n).toLocaleString("fa-IR");
  }
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function getStatus(plant) {
    if (!plant.wateringIntervalDays) return { status: "unknown", diffDays: null };
    const base = plant.lastWatered || plant.addedDate;
    const next = new Date(base);
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + Number(plant.wateringIntervalDays));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((next - today) / 86400000);
    let status = "ok";
    if (diffDays < 0) status = "overdue";
    else if (diffDays <= 1) status = "soon";
    return { status, diffDays, nextDate: next };
  }

  function statusLabel(st) {
    if (st.status === "overdue") {
      const d = Math.abs(st.diffDays);
      return d === 0 ? "امروز نیاز به آبیاری دارد" : `${faNum(d)} روز از موعد آبیاری گذشته`;
    }
    if (st.status === "soon") {
      return st.diffDays === 0 ? "امروز نوبت آبیاری است" : "فردا نوبت آبیاری است";
    }
    if (st.status === "unknown") return "بدون برنامه آبیاری";
    return `${faNum(st.diffDays)} روز تا آبیاری بعدی`;
  }

  // ---------- Image handling ----------
  function resizeImage(file, maxW = 900, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width,
            h = img.height;
          if (w > maxW) {
            h = Math.round((h * maxW) / w);
            w = maxW;
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---------- AI identification (OpenAI or Gemini) ----------
  function dataUrlToRawBase64(dataUrl) {
    const idx = dataUrl.indexOf(",");
    return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  }

  const SYSTEM_PROMPT =
    "شما یک متخصص گیاه‌شناسی و باغبانی هستید. بر اساس عکس گیاه ارسال‌شده، نوع گیاه را شناسایی کن و اطلاعات نگهداری آن را ارائه بده. " +
    "خروجی را فقط و فقط به‌صورت یک JSON معتبر با دقیقاً کلیدهای زیر برگردان، بدون هیچ توضیح اضافه و بدون بک‌تیک یا Markdown:\n" +
    '{"commonName": "نام رایج گیاه به فارسی", "scientificName": "نام علمی به لاتین", ' +
    '"wateringIntervalDays": عدد صحیح فاصله روزهای آبیاری, "light": "نیاز نوری به‌طور خلاصه", ' +
    '"temperatureRange": "محدوده دمای مناسب", "humidity": "نیاز رطوبتی", "soil": "نوع خاک مناسب", ' +
    '"fertilizing": "برنامه کوددهی", "toxicity": "سمی بودن برای حیوان خانگی یا کودک", ' +
    '"commonIssues": "آفات و مشکلات رایج", "tips": "یک نکته کاربردی برای نگهداری بهتر"}';

  async function identifyWithAI(base64Image) {
    const settings = loadSettings();
    if (settings.provider === "openai") {
      return identifyWithOpenAI(base64Image, settings);
    }
    return identifyWithGemini(base64Image, settings);
  }

  async function identifyWithOpenAI(base64Image, settings) {
    if (!settings.openaiKey) {
      throw new Error("ابتدا کلید API OpenAI را در بخش تنظیمات وارد و ذخیره کنید.");
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.openaiKey,
      },
      body: JSON.stringify({
        model: settings.openaiModel || "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "این عکس گیاه من است. لطفاً آن را شناسایی کن و اطلاعات نگهداری‌اش را برگردان." },
              { type: "image_url", image_url: { url: base64Image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      let msg = "خطای سرور OpenAI (کد " + res.status + ")";
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.message) msg = errBody.error.message;
      } catch (e) {}
      throw new Error(msg);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!content) throw new Error("پاسخ نامعتبر از هوش مصنوعی دریافت شد.");
    return JSON.parse(content);
  }

  async function identifyWithGemini(base64Image, settings) {
    if (!settings.geminiKey) {
      throw new Error("ابتدا کلید API گوگل Gemini را در بخش تنظیمات وارد و ذخیره کنید.");
    }
    const model = settings.geminiModel || "gemini-3.5-flash-lite";
    const rawBase64 = dataUrlToRawBase64(base64Image);
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      encodeURIComponent(settings.geminiKey);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT + "\n\nاین عکس گیاه من است. لطفاً آن را شناسایی کن و اطلاعات نگهداری‌اش را برگردان." },
              { inline_data: { mime_type: "image/jpeg", data: rawBase64 } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (!res.ok) {
      let msg = "خطای سرور Gemini (کد " + res.status + ")";
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.message) msg = errBody.error.message;
      } catch (e) {}
      throw new Error(msg);
    }
    const data = await res.json();
    const content =
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!content) throw new Error("پاسخ نامعتبر از هوش مصنوعی دریافت شد.");
    return JSON.parse(content);
  }

  // ---------- Toasts ----------
  function showToast(msg, type) {
    const container = document.getElementById("toastContainer");
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }

  // ---------- Rendering ----------
  function renderStats() {
    const total = plants.length;
    let overdue = 0,
      soon = 0,
      ok = 0;
    plants.forEach((p) => {
      const st = getStatus(p).status;
      if (st === "overdue") overdue++;
      else if (st === "soon") soon++;
      else ok++;
    });
    const row = document.getElementById("statsRow");
    row.innerHTML = `
      <div class="stat-card">
        <span class="num">${faNum(total)}</span>
        <span class="lbl">گیاه در باغچه</span>
      </div>
      <div class="stat-card warn">
        <span class="num">${faNum(overdue)}</span>
        <span class="lbl">نیاز فوری به آبیاری</span>
      </div>
      <div class="stat-card amber">
        <span class="num">${faNum(soon)}</span>
        <span class="lbl">آبیاری تا ۱ روز آینده</span>
      </div>
      <div class="stat-card">
        <span class="num">${faNum(ok)}</span>
        <span class="lbl">سرحال و سالم</span>
      </div>`;
  }

  function dropletSVG() {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 5 11 5 15.5C5 19.6 8.1 22 12 22C15.9 22 19 19.6 19 15.5C19 11 12 2 12 2Z" fill="currentColor"/></svg>';
  }

  function plantCardHTML(plant) {
    const st = getStatus(plant);
    const photo = plant.photo
      ? `<img src="${plant.photo}" alt="${escapeHtml(plant.nickname)}" />`
      : `<div class="no-photo">🌱</div>`;
    return `
      <div class="plant-card" data-id="${plant.id}">
        <div class="plant-photo-wrap">
          ${photo}
          <div class="status-pill ${st.status}">${dropletSVG()}<span>${st.status === "overdue" ? "نیاز به آب" : st.status === "soon" ? "به‌زودی" : "سرحال"}</span></div>
        </div>
        <div class="plant-info">
          <span class="p-name">${escapeHtml(plant.nickname)}</span>
          <span class="p-species">${escapeHtml(plant.commonName || plant.scientificName || "")}</span>
          <div class="p-meta">
            <span>${statusLabel(st)}</span>
            <button class="water-btn" data-water="${plant.id}">${dropletSVG()}آبیاری شد</button>
          </div>
        </div>
      </div>`;
  }

  function applyFilterAndSearch(list) {
    let out = list;
    if (currentFilter !== "all") {
      out = out.filter((p) => getStatus(p).status === currentFilter);
    }
    if (currentSearch.trim()) {
      const q = currentSearch.trim().toLowerCase();
      out = out.filter(
        (p) =>
          (p.nickname || "").toLowerCase().includes(q) ||
          (p.commonName || "").toLowerCase().includes(q) ||
          (p.scientificName || "").toLowerCase().includes(q)
      );
    }
    return out;
  }

  function renderGrid() {
    const grid = document.getElementById("plantsGrid");
    const empty = document.getElementById("emptyState");
    const list = applyFilterAndSearch(plants.slice().sort((a, b) => getStatus(a).diffDays - getStatus(b).diffDays));

    if (plants.length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    if (list.length === 0) {
      grid.innerHTML = `<p style="color:var(--ink-soft);padding:20px 4px;">نتیجه‌ای پیدا نشد.</p>`;
      return;
    }
    grid.innerHTML = list.map(plantCardHTML).join("");
  }

  function renderAll() {
    renderStats();
    renderGrid();
  }

  // ---------- Add Plant modal ----------
  const addModal = document.getElementById("addModal");
  const photoInput = document.getElementById("photoInput");
  const photoPreview = document.getElementById("photoPreview");
  const uploadPlaceholder = document.getElementById("uploadPlaceholder");
  const identifyBtn = document.getElementById("identifyBtn");
  const skipAiBtn = document.getElementById("skipAiBtn");
  const aiStatus = document.getElementById("aiStatus");
  const plantForm = document.getElementById("plantForm");

  function openAddModal() {
    resetAddForm();
    addModal.classList.remove("hidden");
  }
  function closeAddModal() {
    addModal.classList.add("hidden");
  }
  function resetAddForm() {
    pendingPhotoData = null;
    photoPreview.classList.add("hidden");
    photoPreview.src = "";
    uploadPlaceholder.classList.remove("hidden");
    identifyBtn.disabled = true;
    aiStatus.classList.add("hidden");
    aiStatus.textContent = "";
    aiStatus.className = "ai-status hidden";
    plantForm.classList.add("hidden");
    plantForm.reset();
    document.getElementById("f_watering").value = 7;
    photoInput.value = "";
  }

  document.getElementById("uploadZone").addEventListener("click", () => photoInput.click());
  document.getElementById("uploadZone").addEventListener("dragover", (e) => e.preventDefault());
  document.getElementById("uploadZone").addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handlePhotoFile(file);
  });
  photoInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handlePhotoFile(file);
  });

  async function handlePhotoFile(file) {
    try {
      const dataUrl = await resizeImage(file);
      pendingPhotoData = dataUrl;
      photoPreview.src = dataUrl;
      photoPreview.classList.remove("hidden");
      uploadPlaceholder.classList.add("hidden");
      identifyBtn.disabled = false;
    } catch (e) {
      showToast("خطا در بارگذاری عکس", "error");
    }
  }

  identifyBtn.addEventListener("click", async () => {
    if (!pendingPhotoData) return;
    aiStatus.classList.remove("hidden");
    aiStatus.className = "ai-status";
    aiStatus.textContent = "در حال شناسایی گیاه با هوش مصنوعی…";
    identifyBtn.disabled = true;
    try {
      const info = await identifyWithAI(pendingPhotoData);
      fillFormFromAI(info);
      aiStatus.className = "ai-status success";
      aiStatus.textContent = "شناسایی انجام شد. اطلاعات را بررسی و در صورت نیاز ویرایش کنید.";
      plantForm.classList.remove("hidden");
    } catch (e) {
      aiStatus.className = "ai-status error";
      aiStatus.textContent = e.message || "خطا در شناسایی گیاه.";
    } finally {
      identifyBtn.disabled = false;
    }
  });

  skipAiBtn.addEventListener("click", () => {
    plantForm.classList.remove("hidden");
    aiStatus.classList.add("hidden");
  });

  function fillFormFromAI(info) {
    document.getElementById("f_commonName").value = info.commonName || "";
    document.getElementById("f_scientificName").value = info.scientificName || "";
    document.getElementById("f_watering").value = info.wateringIntervalDays || 7;
    document.getElementById("f_light").value = info.light || "";
    document.getElementById("f_temp").value = info.temperatureRange || "";
    document.getElementById("f_humidity").value = info.humidity || "";
    document.getElementById("f_soil").value = info.soil || "";
    document.getElementById("f_fertilizing").value = info.fertilizing || "";
    document.getElementById("f_toxicity").value = info.toxicity || "";
    document.getElementById("f_issues").value = info.commonIssues || "";
    document.getElementById("f_tips").value = info.tips || "";
    if (!document.getElementById("f_nickname").value) {
      document.getElementById("f_nickname").value = info.commonName || "";
    }
  }

  plantForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const plant = {
      id: uid(),
      nickname: document.getElementById("f_nickname").value.trim() || "گیاه بدون نام",
      commonName: document.getElementById("f_commonName").value.trim(),
      scientificName: document.getElementById("f_scientificName").value.trim(),
      photo: pendingPhotoData,
      addedDate: todayISO(),
      lastWatered: null,
      wateringIntervalDays: Number(document.getElementById("f_watering").value) || 7,
      light: document.getElementById("f_light").value.trim(),
      temperatureRange: document.getElementById("f_temp").value.trim(),
      humidity: document.getElementById("f_humidity").value.trim(),
      soil: document.getElementById("f_soil").value.trim(),
      fertilizing: document.getElementById("f_fertilizing").value.trim(),
      toxicity: document.getElementById("f_toxicity").value.trim(),
      commonIssues: document.getElementById("f_issues").value.trim(),
      tips: document.getElementById("f_tips").value.trim(),
      notes: document.getElementById("f_notes").value.trim(),
      wateringLog: [],
    };
    plants.push(plant);
    savePlants(plants);
    renderAll();
    closeAddModal();
    showToast(`«${plant.nickname}» به باغچه اضافه شد 🌿`, "success");
  });

  document.getElementById("addPlantBtn").addEventListener("click", openAddModal);
  document.getElementById("emptyAddBtn").addEventListener("click", openAddModal);
  document.getElementById("closeAddModal").addEventListener("click", closeAddModal);
  document.getElementById("cancelAddBtn").addEventListener("click", closeAddModal);
  addModal.addEventListener("click", (e) => {
    if (e.target === addModal) closeAddModal();
  });

  // ---------- Detail drawer ----------
  const detailOverlay = document.getElementById("detailOverlay");
  const drawerContent = document.getElementById("drawerContent");

  function careItem(label, value, iconPath) {
    if (!value) return "";
    return `<div class="care-item">
      <span class="k"><svg viewBox="0 0 24 24" fill="none">${iconPath}</svg>${label}</span>
      <span class="v">${escapeHtml(value)}</span>
    </div>`;
  }

  function openDetail(id) {
    const plant = plants.find((p) => p.id === id);
    if (!plant) return;
    activeDetailId = id;
    renderDetail(plant);
    detailOverlay.classList.remove("hidden");
  }
  function closeDetail() {
    detailOverlay.classList.add("hidden");
    activeDetailId = null;
  }

  function renderDetail(plant) {
    const st = getStatus(plant);
    const photo = plant.photo ? `<img src="${plant.photo}" alt="" />` : "";
    const logItems = (plant.wateringLog || [])
      .slice()
      .reverse()
      .slice(0, 10)
      .map((d) => `<div class="log-item"><span>آبیاری شد</span><span>${faDate(d)}</span></div>`)
      .join("");

    drawerContent.innerHTML = `
      <div class="drawer-hero">${photo}</div>
      <div class="drawer-body">
        <div class="drawer-title">
          <h2>${escapeHtml(plant.nickname)}</h2>
          <p class="species">${escapeHtml(plant.commonName || "")}${plant.scientificName ? " · " + escapeHtml(plant.scientificName) : ""}</p>
        </div>

        <div class="status-banner ${st.status}">
          <span class="msg">${statusLabel(st)}</span>
          <button class="water-btn" id="drawerWaterBtn">${dropletSVG()}ثبت آبیاری</button>
        </div>

        <div class="care-grid">
          ${careItem("نور", plant.light, '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>')}
          ${careItem("دما", plant.temperatureRange, '<rect x="10" y="3" width="4" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="18" r="3" stroke="currentColor" stroke-width="1.6"/>')}
          ${careItem("رطوبت", plant.humidity, '<path d="M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z" stroke="currentColor" stroke-width="1.6"/>')}
          ${careItem("خاک", plant.soil, '<path d="M3 12h18M3 12c0 4 4 7 9 7s9-3 9-7" stroke="currentColor" stroke-width="1.6"/>')}
          ${careItem("کوددهی", plant.fertilizing, '<path d="M12 22c4-3 7-6 7-10a7 7 0 10-14 0c0 4 3 7 7 10z" stroke="currentColor" stroke-width="1.6"/>')}
          ${careItem("سمیت", plant.toxicity, '<path d="M12 2l9 16H3L12 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>')}
        </div>

        ${plant.commonIssues ? `<div class="section-block"><h4>آفات و مشکلات رایج</h4><p>${escapeHtml(plant.commonIssues)}</p></div>` : ""}
        ${plant.tips ? `<div class="section-block"><h4>نکته نگهداری</h4><p>${escapeHtml(plant.tips)}</p></div>` : ""}

        <div class="section-block notes-box">
          <h4>یادداشت شخصی</h4>
          <textarea id="drawerNotes" placeholder="یادداشت خودتان را بنویسید…">${escapeHtml(plant.notes || "")}</textarea>
        </div>

        ${logItems ? `<div class="section-block"><h4>تاریخچه آبیاری</h4><div class="log-list">${logItems}</div></div>` : ""}

        <div class="drawer-actions">
          <button class="btn-secondary" id="drawerSaveNotes">ذخیره یادداشت</button>
          <button class="btn-danger" id="drawerDeleteBtn">حذف گیاه</button>
        </div>
      </div>`;

    document.getElementById("drawerWaterBtn").addEventListener("click", () => waterPlant(plant.id));
    document.getElementById("drawerSaveNotes").addEventListener("click", () => {
      const val = document.getElementById("drawerNotes").value;
      const p = plants.find((pp) => pp.id === plant.id);
      p.notes = val;
      savePlants(plants);
      showToast("یادداشت ذخیره شد", "success");
    });
    document.getElementById("drawerDeleteBtn").addEventListener("click", () => {
      askConfirm(`آیا از حذف «${plant.nickname}» مطمئن هستید؟`, () => {
        plants = plants.filter((pp) => pp.id !== plant.id);
        savePlants(plants);
        renderAll();
        closeDetail();
        showToast("گیاه حذف شد", "success");
      });
    });
  }

  document.getElementById("closeDrawer").addEventListener("click", closeDetail);
  detailOverlay.addEventListener("click", (e) => {
    if (e.target === detailOverlay) closeDetail();
  });

  function waterPlant(id) {
    const p = plants.find((pp) => pp.id === id);
    if (!p) return;
    const now = todayISO();
    p.lastWatered = now;
    p.wateringLog = p.wateringLog || [];
    p.wateringLog.push(now);
    savePlants(plants);
    renderAll();
    if (activeDetailId === id) renderDetail(p);
    showToast(`آبیاری «${p.nickname}» ثبت شد 💧`, "success");
  }

  // Grid click delegation
  document.getElementById("plantsGrid").addEventListener("click", (e) => {
    const waterBtn = e.target.closest("[data-water]");
    if (waterBtn) {
      e.stopPropagation();
      waterPlant(waterBtn.getAttribute("data-water"));
      spawnRipple(waterBtn);
      return;
    }
    const card = e.target.closest(".plant-card");
    if (card) openDetail(card.getAttribute("data-id"));
  });

  function spawnRipple(el) {
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement("div");
    ripple.className = "ripple-el";
    ripple.style.position = "fixed";
    ripple.style.left = rect.left + rect.width / 2 - 12 + "px";
    ripple.style.top = rect.top + rect.height / 2 - 12 + "px";
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  }

  // ---------- Confirm dialog ----------
  const confirmOverlay = document.getElementById("confirmOverlay");
  let confirmCallback = null;
  function askConfirm(message, onOk) {
    document.getElementById("confirmMessage").textContent = message;
    confirmCallback = onOk;
    confirmOverlay.classList.remove("hidden");
  }
  document.getElementById("confirmOk").addEventListener("click", () => {
    if (confirmCallback) confirmCallback();
    confirmOverlay.classList.add("hidden");
  });
  document.getElementById("confirmCancel").addEventListener("click", () => {
    confirmOverlay.classList.add("hidden");
  });

  // ---------- Filters / search ----------
  document.getElementById("filterChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    currentFilter = chip.getAttribute("data-filter");
    renderGrid();
  });
  document.getElementById("searchInput").addEventListener("input", (e) => {
    currentSearch = e.target.value;
    renderGrid();
  });

  // ---------- Navigation ----------
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.getAttribute("data-view");
      document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
      document.getElementById(view + "View").classList.remove("hidden");
    });
  });

  // ---------- Settings ----------
  function initSettingsForm() {
    const s = loadSettings();
    document.getElementById("providerSelect").value = s.provider || "gemini";
    document.getElementById("geminiKeyInput").value = s.geminiKey || "";
    document.getElementById("geminiModelSelect").value = s.geminiModel || "gemini-3.5-flash-lite";
    document.getElementById("apiKeyInput").value = s.openaiKey || "";
    document.getElementById("modelSelect").value = s.openaiModel || "gpt-4o-mini";
    toggleProviderFields();
  }

  function toggleProviderFields() {
    const provider = document.getElementById("providerSelect").value;
    document.getElementById("geminiFields").classList.toggle("hidden", provider !== "gemini");
    document.getElementById("openaiFields").classList.toggle("hidden", provider !== "openai");
  }
  document.getElementById("providerSelect").addEventListener("change", toggleProviderFields);

  document.getElementById("saveSettingsBtn").addEventListener("click", () => {
    const settings = {
      provider: document.getElementById("providerSelect").value,
      geminiKey: document.getElementById("geminiKeyInput").value.trim(),
      geminiModel: document.getElementById("geminiModelSelect").value,
      openaiKey: document.getElementById("apiKeyInput").value.trim(),
      openaiModel: document.getElementById("modelSelect").value,
    };
    saveSettings(settings);
    const flag = document.getElementById("settingsSaved");
    flag.classList.remove("hidden");
    setTimeout(() => flag.classList.add("hidden"), 2200);
    showToast("تنظیمات ذخیره شد", "success");
  });

  // ---------- Backup / restore ----------
  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ plants, exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "golban-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("فایل پشتیبان دانلود شد", "success");
  });

  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const incoming = Array.isArray(data) ? data : data.plants;
        if (!Array.isArray(incoming)) throw new Error("فرمت فایل نامعتبر است");
        askConfirm(`${faNum(incoming.length)} گیاه از فایل بازیابی شود؟ (به گیاهان فعلی اضافه می‌شود)`, () => {
          plants = plants.concat(incoming);
          savePlants(plants);
          renderAll();
          showToast("بازیابی با موفقیت انجام شد", "success");
        });
      } catch (err) {
        showToast("خطا در خواندن فایل پشتیبان", "error");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- Init ----------
  function setTodayLine() {
    const el = document.getElementById("todayLine");
    const d = new Date().toLocaleDateString("fa-IR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    el.textContent = d;
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
  }

  function init() {
    setTodayLine();
    initSettingsForm();
    renderAll();
    registerServiceWorker();
  }
  init();
})();
