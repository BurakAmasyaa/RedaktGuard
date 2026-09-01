// Model teknik metni Türkçe düzyazı gibi okur.
//
// Bir T-SQL dokümanında kolon adları, veri tipleri ve anahtar kelimeler
// düzenli olarak kişi/kurum diye işaretlenir: "nvarchar", "RETURN", "STG",
// "AS". Bunlar iki ayrı zarar üretir. Birincisi liste kirlenir: kullanıcı
// gerçek isimleri onlarca yanlış pozitifin arasında aramak zorunda kalır ve
// "tümünü seç" güvenilmez hâle gelir. İkincisi maskelenirlerse belge işlevini
// kaybeder — maskelenmiş bir SQL betiği çalışmaz.
//
// Eleme iki ayaklıdır: terimin kendisi (kesin liste) ve terimin bulunduğu
// satırın kod olup olmadığı (bağlam). Bağlam ayağı, listeye giremeyecek
// projeye özgü kısaltmaları da ("STG", "ART") yakalar; çünkü bunlar
// belgede daima bir SQL satırının içinde geçer.

const TECHNICAL_TERMS = new Set([
  // T-SQL / SQL anahtar kelimeleri
  "select", "insert", "update", "delete", "merge", "from", "where", "join", "inner", "outer",
  "left", "right", "full", "cross", "apply", "union", "except", "intersect", "group", "order",
  "having", "into", "values", "set", "declare", "exec", "execute", "return", "returns", "begin",
  "end", "as", "on", "and", "or", "not", "null", "is", "in", "like", "between", "case", "when",
  "then", "else", "top", "distinct", "with", "over", "partition", "by", "asc", "desc", "create",
  "alter", "drop", "truncate", "table", "view", "index", "procedure", "proc", "function",
  "trigger", "database", "schema", "primary", "foreign", "key", "constraint", "unique", "check",
  "default", "identity", "cast", "convert", "isnull", "coalesce", "count", "sum", "avg", "min",
  "max", "len", "substring", "getdate", "print", "raiserror", "try", "catch", "throw", "commit",
  "rollback", "transaction", "tran", "cursor", "fetch", "while", "output", "nolock", "rowlock",
  "tablock", "go", "use", "grant", "revoke", "deny", "add", "column", "rename",
  // Veri tipleri
  "int", "integer", "bigint", "smallint", "tinyint", "bit", "decimal", "numeric", "float",
  "real", "money", "smallmoney", "char", "varchar", "nchar", "nvarchar", "text", "ntext",
  "date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time", "timestamp",
  "uniqueidentifier", "varbinary", "binary", "image", "xml", "json", "sql_variant", "rowversion",
  // Programlama / veri ambarı kısaltmaları
  "dbo", "sys", "stg", "etl", "elt", "ods", "dwh", "edw", "src", "tgt", "tmp", "temp", "staging",
  "true", "false", "void", "string", "boolean", "object", "array", "class", "public", "private",
  "protected", "static", "import", "export", "const", "let", "var", "async", "await", "yield",
  // "elif" bilerek listede yok: Python anahtar kelimesi olsa da Türkiye'nin en
  // yaygın kadın adlarından biri ve hiçbir bağlamda maskelenmemesi kabul edilemez.
  "new", "this", "self", "def", "lambda", "struct", "enum", "interface", "namespace",
  "nan", "undefined", "todo", "fixme", "utf", "ascii", "guid", "uuid", "http", "https", "api",
  "url", "uri", "sql", "server", "agent", "job", "query", "batch", "log", "error", "warning",
  "debug", "info", "trace", "id", "pk", "fk",
]);

// Satırın kod olduğunu gösteren izler. Tek bir iz yeterlidir: düzyazı Türkçe
// bir cümlede bunlardan hiçbiri bulunmaz.
const CODE_LINE_PATTERNS = [
  /\b(?:select|insert\s+into|update|delete\s+from|from|where|inner\s+join|left\s+join|declare|exec(?:ute)?|create\s+(?:table|view|proc|procedure|function|index)|alter\s+table|drop\s+table|group\s+by|order\s+by|union\s+all|begin\s+tran|set\s+@)\b/iu,
  /\[[\p{L}_][\p{L}\p{N}_]*\]\s*\.\s*\[/u,
  /\b(?:n?varchar|n?char|decimal|numeric|datetime2?|bigint|smallint|tinyint|uniqueidentifier|var(?:binary))\s*\(/iu,
  // db.schema.table — her parça en az iki karakter olmalı, yoksa Türkçe
  // kısaltmalar ("ABC A.Ş.de") kod sanılır.
  /\b[\p{L}_][\p{L}\p{N}_]+\.[\p{L}_][\p{L}\p{N}_]+\.[\p{L}_][\p{L}\p{N}_]+\b/u,
  /(?:^|\s)--\s/u,
  /(?:^|\s)(?:\/\*|\*\/)/u,
  /[{}]\s*$/u,
  /\b(?:is\s+null|not\s+null|primary\s+key|foreign\s+key)\b/iu,
];

// Değerin kendisi bir tanımlayıcı gibi görünüyor mu. Türkçe bir özel ad
// böyle yazılmaz.
// Biçim sezgileri dar tutulur. "Tümü küçük harf" ve "snake_case" kuralları
// gerçek adları eliyordu: tamamı küçük harf yazılmış bir formdaki "ahmet" ve
// dosya adından gelen "Kerem_Aydin" sessizce düşüyordu. Bu iki biçimin asıl
// hedefi olan SQL tanımlayıcıları ("nvarchar", "sql_variant") zaten kesin
// terim listesinde ve kod bağlamı ayağında yakalanıyor.
const IDENTIFIER_SHAPES = [
  /[\p{L}]\p{N}|\p{N}[\p{L}]/u,           // harf ve rakam iç içe: "datetime2", "varchar50"
  /[%$#*+=<>/\\|^~`]/u,                  // biçim/operatör karakteri: "%d"
];

function normalizeTerm(value) {
  return String(value).normalize("NFC").toLocaleLowerCase("tr-TR").trim();
}

export function isTechnicalTerm(value) {
  const normalized = normalizeTerm(value);
  if (!normalized) return false;
  // Çok sözcüklü değerde her sözcük teknikse bütünü de tekniktir:
  // "SQL Server Agent", "primary key".
  const words = normalized.split(/[\s.\-_]+/u).filter(Boolean);
  if (!words.length) return false;
  return words.every((word) => TECHNICAL_TERMS.has(word));
}

// E-posta ve URL bir satırı kod yapmaz. "@ornek" parçası SQL parametresine,
// "ornek.com.tr" ise db.schema.table biçimine benziyordu; sonuçta imza bloğu
// ya da kaynakça satırındaki GERÇEK adlar sessizce eleniyordu. Kod denetimi
// bunlar çıkarıldıktan sonra yapılır.
const EMAIL_OR_URL = /(?:[a-z][a-z0-9+.\-]*:\/\/\S+|\bwww\.\S+|[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+)/giu;

export function looksLikeCodeLine(line) {
  const text = String(line || "").replace(EMAIL_OR_URL, " ");
  if (!text.trim()) return false;
  return CODE_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/\s/u.test(text)) return false;
  return IDENTIFIER_SHAPES.some((pattern) => pattern.test(text));
}

// Kod satırında bile her şey tanımlayıcı değildir.
//
// Satırın tamamını elemek, veri taşıyan satırlardaki GERÇEK adları da
// düşürüyordu: "-- Ahmet Yılmaz tarafından güncellendi" ve
// "INSERT INTO Musteri VALUES ('Ahmet Yılmaz', ...)" satırlarındaki ad
// maskelenmeden kalıyordu. Bu, teknik gürültüyü elemek için ödenecek bedelden
// çok daha ağır bir arızadır — doğrudan sızıntıdır.
//
// Yorum içi ve tırnak içi metin VERİDİR, tanımlayıcı değildir; çok sözcüklü
// bir değer de tanımlayıcı olamaz. Kod bağlamı yalnızca geriye kalanı eler.
const LINE_COMMENT = /(?:--|\/\/|#)/u;

function insideLineComment(line, offset) {
  const before = line.slice(0, offset);
  const match = LINE_COMMENT.exec(before);
  return Boolean(match);
}

function insideBlockComment(line, offset) {
  const before = line.slice(0, offset);
  const opened = before.lastIndexOf("/*");
  if (opened < 0) return false;
  return before.indexOf("*/", opened) < 0;
}

function insideQuotes(line, offset) {
  let single = 0;
  let double = 0;
  for (let index = 0; index < offset && index < line.length; index += 1) {
    if (line[index] === "'") single += 1;
    else if (line[index] === '"') double += 1;
  }
  return single % 2 === 1 || double % 2 === 1;
}

export function isDataInCodeLine(line, offset) {
  if (typeof offset !== "number" || offset < 0) return false;
  return insideLineComment(line, offset) || insideBlockComment(line, offset) || insideQuotes(line, offset);
}

// Tek karar noktası: bu değer, bu satırın bu konumunda, bir kişi/kurum/konum
// sayılmalı mı.
export function isTechnicalNoise(value, line = "", offset = -1) {
  if (isTechnicalTerm(value) || looksLikeIdentifier(value)) return true;
  if (!looksLikeCodeLine(line)) return false;
  if (isDataInCodeLine(line, offset)) return false;
  // Çok sözcüklü değer bir tanımlayıcı olamaz: "Ahmet Yılmaz" kod satırında da addır.
  return !/\s/u.test(String(value).trim());
}
