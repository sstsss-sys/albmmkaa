const { chromium } = require("playwright");
const fs = require("fs");

const countries = require("./countries.json");

const historyPath = "./apple-music-albums-history.json";
const allHistoryPath = "./apple-music-albums-all-history.json";
const usHistoryPath = "./us-albums-history.json";

function getHistory() {
  try {
    if (fs.existsSync(historyPath)) {
      return JSON.parse(fs.readFileSync(historyPath, "utf8"));
    }
    return {
      lastUpdated: "",
      entries: []
    };
  } catch {
    return {
      lastUpdated: "",
      entries: []
    };
  }
}

function getAllHistory() {
  try {
    if (fs.existsSync(allHistoryPath)) {
      return JSON.parse(fs.readFileSync(allHistoryPath, "utf8"));
    }
    return [];
  } catch {
    return [];
  }
}

function getUsHistory() {
  try {
    if (fs.existsSync(usHistoryPath)) {
      return JSON.parse(fs.readFileSync(usHistoryPath, "utf8"));
    }
    return [];
  } catch {
    return [];
  }
}

// 🛠️ PERBAIKAN: isJiminAlbum sekarang menerima objek utuh
function isJiminAlbum(album) {
  const textToCheck = (album.rawAria || "").toLowerCase();
  return textToCheck.includes("jimin");
}

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const history = getHistory();
  const usHistory = getUsHistory();
  const allHistory = getAllHistory();

  const previousEntries = history.entries || [];
  const allEntries = [];
  
  const page = await browser.newPage();

  await page.goto("https://music.apple.com/us/new/top-charts/albums", {
    waitUntil: "networkidle"
  });

  await page.waitForTimeout(5000);

  const scrollable = await page.locator("#scrollable-page");

  for (let i = 0; i < 20; i++) {
    await scrollable.evaluate(el => {
      el.scrollBy(0, 5000);
    });
    await page.waitForTimeout(500);
  }

  const usTop200 = await page.evaluate(() => {
    const seen = new Set();

    return [...document.querySelectorAll('a[href*="/album/"]')]
      .map(a => {
        const card = a.closest('[aria-label]') || a.parentElement;
        return card?.getAttribute("aria-label") || "";
      })
      .filter(item => {
        if (!item) return false;
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      })
      .slice(0, 200);
  });

  console.log("US Albums:", usTop200.length);

  await page.close();

  const oldUs = JSON.stringify(usHistory);
  const newUs = JSON.stringify(usTop200);

  if (oldUs === newUs) {
    console.log("🟰 US album chart not updated");
    await browser.close();
    return;
  }

  console.log("📈 US album chart updated");

  fs.writeFileSync(usHistoryPath, JSON.stringify(usTop200, null, 2));

  const BATCH_SIZE = 5;

  for (let i = 0; i < countries.length; i += BATCH_SIZE) {
    const batch = countries.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async country => {
        const page = await browser.newPage();

        try {
          console.log(`🌍 ${country.country}`);

          await page.goto(`https://music.apple.com/${country.code}/new/top-charts/albums`, {
            waitUntil: "networkidle"
          });

          await page.waitForTimeout(5000);

          const scrollable = await page.locator("#scrollable-page");

          let count = 0;
          let lastCount = 0;

          // 🛠️ PERBAIKAN 1: Harus cari minimal 400 link, karena 1 album = 2 link!
          while (count < 450) {
            await scrollable.evaluate(el => {
              el.scrollBy(0, 5000);
            });

            await page.waitForTimeout(1000);

            count = await page.locator('a[href*="/album/"]').count();

            if (count === lastCount) {
              break;
            }
            lastCount = count;
          }

          const albums = await page.evaluate(countryName => {
            const seen = new Set();

            return [...document.querySelectorAll('a[href*="/album/"]')]
              .map((a, index) => {
                const card = a.closest('[aria-label]') || a.parentElement;
                
                // Coba ambil dari atribut parent, kalau tidak ada coba dari elemen itu sendiri
                const aria = card?.getAttribute("aria-label") || a.getAttribute("aria-label") || "";

                // 🛠️ PERBAIKAN: Bersihkan juga kata "Explícita y" (Spanyol) bukan cuma "Explicit,"
                let clean = aria.replace(/^Explicit(a)?(,\s*|\s*y\s*)/i, "");
                const parts = clean.split(",");

                // 🛠️ PERBAIKAN: Ambil judul dari teks elemen aslinya agar lebih presisi
                const title = a.textContent?.trim() || parts.shift()?.trim() || "";
                const artist = parts.join(",").trim();

                return {
                  country: countryName,
                  title,
                  artist,
                  rawAria: aria, 
                  image: a.closest('[data-testid="grid-item"]')?.querySelector("picture source")?.getAttribute("srcset")?.split(",")[0]?.split(" ")[0] || "",
                  songLink: a.href
                };
              })
              .filter(item => {
                // 🛠️ PERBAIKAN 2: Abaikan link kosong (gambar) supaya tidak merusak Set seen!
                if (!item.rawAria && !item.title) return false;

                if (seen.has(item.songLink)) {
                  return false;
                }
                seen.add(item.songLink);
                return true;
              })
              // Atur ulang rank karena kita membuang link ganda
              .map((item, index) => {
                  item.rank = index + 1;
                  return item;
              })
              .slice(0, 200); // Pastikan limitnya kembali ke Top 200
          }, country.country);

          await page.close();

          console.log(
            country.country,
            albums.find(album => album.title?.toLowerCase().includes("muse"))
          );

          // Cek menggunakan data mentah yang aman
          return albums.filter(album => isJiminAlbum(album));

        } catch (err) {
          console.log(`❌ ${country.country}`, err.message);
          await page.close();
          return [];
        }
      })
    );

    allEntries.push(...results.flat());
    console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1} finished`);
  }

  const finalEntries = allEntries.map(current => {
    const previous = previousEntries.find(
      item => item.country === current.country && item.title === current.title
    );

    let status = "NEW";
    let change = "NEW";
    let previousRank = null;

    if (previous) {
      previousRank = previous.rank;
      const diff = previous.rank - current.rank;

      if (diff > 0) {
        status = "up";
        change = `+${diff}`;
      } else if (diff < 0) {
        status = "down";
        change = `${diff}`;
      } else {
        status = "stable";
        change = "—";
      }
    } else {
      const appearedBefore = allHistory.some(
        old => old.country === current.country && old.title === current.title
      );

      if (appearedBefore) {
        status = "RE";
        change = "RE";
      }
    }

    return {
      country: current.country,
      rank: current.rank,
      previousRank,
      change,
      status,
      title: current.title,
      artist: current.artist,
      image: current.image,
      songLink: current.songLink
    };
  });

  const mergedHistory = [...allHistory];

  finalEntries.forEach(album => {
    const exists = mergedHistory.find(
      item => item.country === album.country && item.title === album.title
    );

    if (!exists) {
      mergedHistory.push({
        country: album.country,
        title: album.title
      });
    }
  });

  fs.writeFileSync(allHistoryPath, JSON.stringify(mergedHistory, null, 2));

  const output = {
    updatedDate: new Date().toISOString(),
    totalEntries: finalEntries.length,
    entries: finalEntries.sort((a, b) => a.rank - b.rank)
  };

  fs.writeFileSync(
    historyPath,
    JSON.stringify(
      {
        lastUpdated: output.updatedDate,
        entries: finalEntries
      },
      null,
      2
    )
  );

  fs.writeFileSync("apple-music-albums-realtime.json", JSON.stringify(output, null, 2));

  console.log(`🔥 ${finalEntries.length} Jimin album entries found`);
  console.log("Saved apple-music-albums-realtime.json");

  await browser.close();
})();

