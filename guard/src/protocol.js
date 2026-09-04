// Eklentinin parçaları arasındaki tek sözleşme.
// İçerik betiği (isolated), sayfa koruması (main), service worker ve
// offscreen belge yalnızca buradaki adları kullanır.

// İçerik betiği bu adla BAĞLANIR; bağlantıyı service worker karşılar.
export const ENGINE_PORT = "redakt-guard-engine";

// Service worker'ın offscreen belgeye açtığı iç port. İçerik betiğinin
// doğrudan offscreen belgeye bağlanabildiği MV3'te garanti değildir; bu yüzden
// akış her zaman service worker üzerinden röle edilir.
export const ENGINE_RELAY_PORT = "redakt-guard-engine-relay";

// Sayfa dünyasındaki betikle konuşurken kullanılan işaret.
// Gizli değildir: sayfa özgün dosyayı hiçbir zaman görmediği için
// bu kanalın taklit edilmesi saldırgana bir şey kazandırmaz.
export const GUARD_MARK = "redakt-guard/v1";

// Ayar ve onaylar iki dünyanın ortak DOM'una yazılır, postMessage ile değil.
// Sebep bir yarış: sayfa "drop" olayını eşzamanlı işleyip yüklemeyi hemen
// başlatabilir; kuyruğa alınmış bir mesaj o ana yetişmez ve kendi maskelediğimiz
// dosya engellenir. Öznitelik okuması eşzamanlıdır, bu yarışı ortadan kaldırır.
// Değerler JSON'dur: dosya adı satır sonu içerebildiği için düz birleştirme
// hem kendi onayımızı bozar hem de sahte onay üretmeye izin verirdi.
export const CONFIG_ATTRIBUTE = "data-redakt-guard";
export const APPROVED_ATTRIBUTE = "data-redakt-guard-approved";

// Maskelenmiş FileList isolated dünyada hazırlanır, fakat Gemini/Claude'un
// framework dinleyicileri olayı sayfanın kendi (MAIN) dünyasında bekleyebilir.
// İçerik betiği bu olayı gerçek file input üzerinde tetikler; page-guard aynı
// güvenli FileList için yerel input/change olaylarını üretip jetonu onaylar.
export const FILE_DELIVERY_EVENT = "redakt-guard/file-delivery";
export const FILE_DELIVERY_TOKEN_ATTRIBUTE = "data-redakt-guard-delivery";
export const FILE_DELIVERY_ACK_ATTRIBUTE = "data-redakt-guard-delivery-ack";

// Drag/drop ile başlayan akışlarda Gemini ve Claude dosyayı kendi MAIN-world
// DragEvent zincirinden bekliyor. Güvenli FileList geçici bir file input'ta
// tutulur; sayfa köprüsü yalnız maskelenmiş kopyayla yerel drag olayları üretir.
export const DROP_DELIVERY_EVENT = "redakt-guard/drop-delivery";
export const DROP_CLEANUP_EVENT = "redakt-guard/drop-cleanup";
export const DROP_DELIVERY_TOKEN_ATTRIBUTE = "data-redakt-guard-drop-delivery";
export const DROP_DELIVERY_TARGET_ATTRIBUTE = "data-redakt-guard-drop-target";
export const DROP_DELIVERY_POINT_ATTRIBUTE = "data-redakt-guard-drop-point";
export const DROP_DELIVERY_ACK_ATTRIBUTE = "data-redakt-guard-drop-ack";
export const DROP_DELIVERY_ACTIVE_ATTRIBUTE = "data-redakt-guard-drop-active";

export const MSG = Object.freeze({
  ensureEngine: "guard/ensure-engine",
  restartEngine: "guard/restart-engine",
  readTrace: "guard/read-trace",
  readDiagnostics: "guard/read-diagnostics",
  diagnosticOperation: "guard/diagnostic-operation",
  mark: "guard/mark",
  readSettings: "guard/read-settings",
  writeSettings: "guard/write-settings",
  readRules: "guard/read-rules",
  readEngineState: "guard/read-engine-state",
  writeEngineDevice: "guard/write-engine-device",
  auditMasking: "guard/audit-masking",
  refreshRules: "guard/refresh-rules",
  activity: "guard/activity",
  // İçerik betiği korunan sayfada yüklenince bildirir; rozet "bu sekmede aktif" olur.
  contentReady: "guard/content-ready",
  // Çökme sonrası güvenli yola düşüldüyse GPU'yu yeniden dener (işaretleri siler).
  retryGpu: "guard/retry-gpu",
});

export const CMD = Object.freeze({
  ready: "ready",
  scanBegin: "scan-begin",
  scanChunk: "scan-chunk",
  scanEnd: "scan-end",
  scanResult: "scan-result",
  scanText: "scan-text",
  maskText: "mask-text",
  maskTextResult: "mask-text-result",
  mask: "mask",
  maskBegin: "mask-begin",
  maskChunk: "mask-chunk",
  maskEnd: "mask-end",
  progress: "progress",
  failure: "failure",
  release: "release",
});

// Sayfa dünyasından geri gelen mesajlar. Yükleme olaylarında dosya adı, içerik
// veya URL taşınmaz; yalnız güvenli kopyaya ait ağ işinin başlayıp bittiği
// bildirilir. Bu bilgi kullanıcıya dürüst bir "site hâlâ yüklüyor" durumu
// göstermek için kullanılır, güvenlik kararı için kullanılmaz.
export const PAGE = Object.freeze({
  blocked: "blocked",
  uploadStarted: "upload-started",
  uploadFinished: "upload-finished",
});

// Motorun açabildiği türler. Bu listenin dışı taranamaz; taranamayan
// dosyaya ne yapılacağı ayarlardaki blockUnscannable ile belirlenir.
export const SCANNABLE_EXTENSIONS = Object.freeze(["docx", "xlsx", "pdf", "txt", "jpg", "jpeg", "png"]);

export const MAX_SCANNABLE_BYTES = 50 * 1024 * 1024;

// Base64'e çevrilen parça boyutu. 512 KB ham veri ~683 KB metin eder;
// chrome.runtime mesajlaşması bu ölçekte sorunsuz çalışır.
export const CHUNK_BYTES = 512 * 1024;

// Motordan bu süre boyunca HİÇ mesaj gelmezse takılmış sayılır. Model ilk kez
// hazırlanırken bile ilerleme sürekli akar (yüzde yüzde), yani bu kadar tam
// sessizlik ancak offscreen belge kilitlendiğinde olur.
export const ENGINE_SILENCE_TIMEOUT_MS = 45_000;

// Motor sessiz ama sağlıklı çalışırken (PDF çıktısının yazılması, büyük belgenin
// ayrıştırılması) bu aralıkla son ilerleme yeniden yayınlanır. Gözcü aksi hâlde
// sağlıklı işi "sustu" sanıp motoru yeniden kuruyordu — sahada PDF %100'de
// "Tarama motoru yeniden kuruldu" ile bitti.
export const ENGINE_HEARTBEAT_MS = 5_000;

// Kalp atışının tavanı. Sessizlik bu kadar sürerse iş sağlıklı-yavaş değil
// asılıdır; kalp atışı susar ve 45 sn sonra gözcü motoru yeniden kurar.
// Kalp atışı sınırsız olsaydı gerçek bir asılma sonsuza kadar "yazılıyor" derdi.
export const ENGINE_HEARTBEAT_MAX_MS = 5 * 60_000;

export function extensionOf(filename) {
  const match = /\.([^.]+)$/u.exec(String(filename || "").toLowerCase());
  return match ? match[1] : "";
}

export function isScannable(filename) {
  return SCANNABLE_EXTENSIONS.includes(extensionOf(filename));
}

// Sayfa dünyasındaki koruma yalnız ad ve boyutu görebilir; onay anahtarı bu ikisidir.
export function fileKey(name, size) {
  return `${String(name || "")}|${Number(size) || 0}`;
}

// Siteler dosyayı kendi adını taşımayan ham bir gövdeye sarabiliyor (imzalı
// URL'e PUT edilen Blob gibi). O gövdede ad yoktur, geriye tek ayırt edici
// olarak bayt uzunluğu kalır. Onay bu yüzden ada ek olarak boyutla da yazılır.
export function sizeKey(size, at = Date.now()) {
  return `#${Number(size) || 0}|${Number(at) || 0}`;
}

// "#boyut|zaman" anahtarını çözer; biçim tutmuyorsa null.
export function parseSizeKey(key) {
  const match = /^#(\d+)\|(\d+)$/u.exec(String(key || ""));
  return match ? { size: Number(match[1]), at: Number(match[2]) } : null;
}

// Boyut onayı sekme ömrü boyunca değil, bu süre boyunca geçerlidir. Aksi hâlde
// ilk onaydan sonra adsız gövde koruması o sekmede fiilen kapanıyordu.
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

// Bu boyutun altındaki adsız ikili gövdeler yükleme sayılmaz; siteler JSON ve
// telemetriyi de Blob olarak gönderiyor ve onları engellemek sızıntıyı
// durdurmaz, siteyi kırar.
export const BINARY_BODY_FLOOR_BYTES = 4096;

// Belge türü belli olmayan adsız gövde ancak bu boyutun üstündeyse yükleme
// sayılır. Google telemetrisi (protobuf/log) 4-100 KB arası Blob gönderiyor;
// sahada temiz PDF'te bile "adsız yükleme" uyarısı bu yüzden çıktı.
export const LARGE_BINARY_BYTES = 256 * 1024;
