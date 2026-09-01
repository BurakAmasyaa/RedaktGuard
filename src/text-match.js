// Eşleştirme normalizasyonu: iki yazımın "aynı değer" sayılıp sayılmadığına
// tek yerden karar verilir.
//
// Belgede geçen yazımı önceden bilmek mümkün değildir. Kullanıcı kuralına
// "Kerem" yazar, belge "KEREM" der; model "LEAF" yakalar, başka bir köşede
// "Leaf" durur; Excel'in UPPER()'ı "Melis"i "MELIS" yapar; bir kopyala-yapıştır
// adın ortasına yumuşak tire bırakır; Word bir harfi ayrışık (NFD) yazar.
// Bunların hepsi aynı değerdir ve eşleşme birinde kopuyorsa sonuç maskeleme
// eksiği, yani doğrudan sızıntıdır.
//
// Katlama dört şeyi birden yapar:
//   1. Birleştirici işaretleri düşürür  -> ayrışık (NFD) yazım birleşikle eşleşir
//   2. Görünmez biçim karakterlerini atar -> yumuşak tire / ZWJ ile kaçırma çalışmaz
//   3. Türkçe diyakritikleri indirger    -> "Işıl" ile "Isil" aynı değerdir
//   4. Küçük harfe indirir
//
// (3) bilinçli bir genişletmedir: Türkçe belgelerde diyakritiksiz yazım
// olağandır ve kurumsal kural motoru zaten bu davranışa sahipti. İki kural
// yolunun farklı davranması, kullanıcının kuralını yazıp maskelendiğini
// sanmasına yol açıyordu. Nokta ayrımı da (I/İ/ı/i) burada kaybolur: aksi
// hâlde locale'siz bir toUpperCase ("MELIS") aynı adı bir daha yakalatmıyordu.

// Sınır denetimi ham metin üzerinde yapılır; orada birleştirici işaret hâlâ
// duruyor olabilir ve sözcüğün parçasıdır. Sınıfa alınmazsa ayrışık metinde
// "Eker" kuralı "şeker" sözcüğünün ortasında eşleşiyordu.
// Alt çizgi sözcük sınırı SAYILMAZ. Kurumsal kural tespiti token tabanlıdır
// (ayırıcı ne olursa olsun eşleşir), maskeleme ise sınır tabanlı; ikisi
// ayrıştığında "20240115_Kerem_Aydin_dilekce.pdf" gibi ek adlarında ad
// BULUNUYOR ama maskelenmiyordu. Sayım da maskelemeden geldiği için kullanıcı
// hiçbir uyarı görmüyordu.
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;
const IGNORABLE = /[\p{Cf}\p{M}]/u;

const TURKISH_FOLD = new Map(Object.entries({
  İ: "i", I: "i", ı: "i", i: "i",
  Ş: "s", ş: "s", Ğ: "g", ğ: "g",
  Ü: "u", ü: "u", Ö: "o", ö: "o", Ç: "c", ç: "c",
  Â: "a", â: "a", Î: "i", î: "i", Û: "u", û: "u",
}));

// Karakter başına katlama bir kez hesaplanır; belgede geçen alfabe küçüktür.
const foldCache = new Map();

function foldCharacter(character) {
  let folded = foldCache.get(character);
  if (folded === undefined) {
    folded = SEPARATOR.test(character)
      ? " "
      : TURKISH_FOLD.get(character) ?? (IGNORABLE.test(character) ? "" : character.toLowerCase());
    foldCache.set(character, folded);
  }
  return folded;
}

// Sözcükleri ayıran her şey tek bir boşluğa iner.
//
// Word/Excel/PDF kırılmaz boşluk (U+00A0) üretir, satır kaydırma ada satır
// sonu sokar, kopyala-yapıştır çift boşluk bırakır, dosya adları boşluk yerine
// alt çizgi/tire/nokta kullanır ("20240115_Kerem_Aydin_dilekce.pdf"). Çok
// kelimeli bir kural bunların hepsinde sessizce düşüyordu — aynı kural
// kurumsal listeden geldiğinde token tabanlı olduğu için çalışıyordu. Bu
// ayrışma, tespitin "buldum" deyip maskelemenin dokunmaması demekti.
const SEPARATOR = /[\s_.\-–—]/u;

// Kod birimi kod birimi gezilir. Vekil çift yarıları hiçbir kurala uymaz,
// olduğu gibi geçer ve uzunluk korunur; kod noktası yineleyicisi ise 1 MB'lık
// bir metinde ölçülebilir bir yük getiriyordu.
export function foldForMatching(value) {
  const source = String(value);
  let folded = "";
  let lastWasSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const mapped = foldCharacter(source[index]);
    if (mapped === " ") {
      if (lastWasSpace) continue;
      lastWasSpace = true;
    } else if (mapped) {
      lastWasSpace = false;
    }
    folded += mapped;
  }
  return folded;
}

// Katlanmış konum ham metne geri çevrilebilmeli: maskeleme tam olarak ham
// metindeki aralığın üzerine yazar. Katlama uzunluğu değiştirmediyse eşlem
// birimdir ve hiç dizi kurulmaz.
export function createFoldedIndex(text) {
  const source = String(text);
  const folded = foldForMatching(source);
  // Uzunluk değişmediyse eşlem birimdir; konum dizisi HİÇ kurulmaz. Diziyi her
  // seferinde kurup sonra atmak 1 MB'lık tek bir metin biriminde 8 saniye
  // sürüyordu — tarama sırasında görünen donmanın kaynağı buydu.
  if (folded.length === source.length) return { source, folded, offsets: null };

  const offsets = [];
  let mappedText = "";
  let lastWasSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    let mapped = foldCharacter(source[index]);
    if (mapped === " ") {
      if (lastWasSpace) mapped = "";
      else lastWasSpace = true;
    } else if (mapped) {
      lastWasSpace = false;
    }
    if (mapped) offsets.push(index);
    mappedText += mapped;
  }
  offsets.push(source.length);
  return { source, folded: mappedText, offsets };
}

function sourceOffset(index, foldedPosition) {
  return index.offsets ? index.offsets[foldedPosition] : foldedPosition;
}

// Aynı ifade binlerce birimde aranır; katlaması ve sınır kararı ifadeye
// bağlıdır, metne değil.
const MAX_CACHED_NEEDLES = 4096;
const needleCache = new Map();

function describeNeedle(needle) {
  const key = String(needle);
  const cached = needleCache.get(key);
  if (cached) return cached;
  const characters = [...key];
  const described = {
    folded: foldForMatching(key),
    // Sınır denetimi `\b` gibi davranır: yalnızca aranan ifadenin kendi ucu
    // harf/rakamsa o taraf sınıra zorlanır. İki yanı koşulsuz zorlamak
    // "@ornek.com.tr" gibi kuralları hiç eşleştiremezdi; hiç zorlamamak ise
    // harf duyarsız aramada felakettir: "Ali" kuralı "kalite"nin içini yakalar.
    guardLeft: WORD_CHARACTER.test(characters[0] || ""),
    guardRight: WORD_CHARACTER.test(characters.at(-1) || ""),
  };
  if (needleCache.size >= MAX_CACHED_NEEDLES) needleCache.clear();
  needleCache.set(key, described);
  return described;
}

// Çakışmayan eşleşmeler, soldan sağa.
export function findOccurrences(index, needle, { wholeWord = false } = {}) {
  const described = describeNeedle(needle);
  const { folded } = described;
  if (!folded) return [];
  const guardLeft = wholeWord && described.guardLeft;
  const guardRight = wholeWord && described.guardRight;

  const found = [];
  let cursor = 0;
  while (cursor <= index.folded.length - folded.length) {
    const at = index.folded.indexOf(folded, cursor);
    if (at < 0) break;
    cursor = at + folded.length;
    const start = sourceOffset(index, at);
    const end = sourceOffset(index, at + folded.length);
    if (!(end > start)) continue;
    if (guardLeft && WORD_CHARACTER.test(index.source[start - 1] || "")) continue;
    if (guardRight && WORD_CHARACTER.test(index.source[end] || "")) continue;
    found.push({ start, end, text: index.source.slice(start, end) });
  }
  return found;
}

export function findFoldedOccurrences(text, needle, options = {}) {
  return findOccurrences(createFoldedIndex(text), needle, options);
}
