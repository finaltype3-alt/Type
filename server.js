const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const helmet = require("helmet");
const { createStore } = require("./lib/store-core");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || "institution_admin";
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "OC&S11749";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

const db = new Database(path.join(__dirname, "exam.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'English',
    duration_min INTEGER NOT NULL DEFAULT 5,
    wpm INTEGER NOT NULL DEFAULT 25,
    full_marks REAL NOT NULL DEFAULT 100,
    source_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    candidate_name TEXT NOT NULL,
    candidate_name_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    started_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    UNIQUE (exam_id, candidate_name_key)
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    candidate_name TEXT NOT NULL,
    total_words INTEGER NOT NULL DEFAULT 0,
    mistake_words INTEGER NOT NULL DEFAULT 0,
    correct_words INTEGER NOT NULL DEFAULT 0,
    accuracy REAL NOT NULL DEFAULT 0,
    final_marks REAL NOT NULL DEFAULT 0,
    typed_text TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );
`);

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some((columnInfo) => columnInfo.name === column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

// Compatibility with older databases.
addColumnIfMissing("exams", "code", "TEXT");
addColumnIfMissing(
  "exams",
  "title",
  "TEXT NOT NULL DEFAULT 'Typing Examination'"
);
addColumnIfMissing(
  "exams",
  "language",
  "TEXT NOT NULL DEFAULT 'English'"
);
addColumnIfMissing(
  "exams",
  "duration_min",
  "INTEGER NOT NULL DEFAULT 5"
);
addColumnIfMissing(
  "exams",
  "wpm",
  "INTEGER NOT NULL DEFAULT 25"
);
addColumnIfMissing(
  "exams",
  "full_marks",
  "REAL NOT NULL DEFAULT 100"
);
addColumnIfMissing(
  "exams",
  "source_text",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "exams",
  "status",
  "TEXT NOT NULL DEFAULT 'active'"
);
addColumnIfMissing(
  "exams",
  "created_at",
  "TEXT NOT NULL DEFAULT (datetime('now'))"
);

addColumnIfMissing(
  "registrations",
  "candidate_name",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "registrations",
  "candidate_name_key",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "registrations",
  "status",
  "TEXT NOT NULL DEFAULT 'registered'"
);
addColumnIfMissing("registrations", "started_at", "TEXT");
addColumnIfMissing("registrations", "expires_at", "TEXT");
addColumnIfMissing(
  "registrations",
  "created_at",
  "TEXT NOT NULL DEFAULT (datetime('now'))"
);

addColumnIfMissing(
  "results",
  "candidate_name",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "results",
  "total_words",
  "INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "results",
  "mistake_words",
  "INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "results",
  "correct_words",
  "INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "results",
  "accuracy",
  "REAL NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "results",
  "final_marks",
  "REAL NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "results",
  "typed_text",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "results",
  "reason",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "results",
  "created_at",
  "TEXT NOT NULL DEFAULT (datetime('now'))"
);

function makeExamCode() {
  return "INST-" +
    crypto.randomBytes(4).toString("hex").toUpperCase();
}

// Give older examinations a code if they do not already have one.
const examsWithoutCode = db.prepare(
  "SELECT id FROM exams WHERE code IS NULL OR TRIM(code) = ''"
).all();

for (const exam of examsWithoutCode) {
  db.prepare("UPDATE exams SET code = ? WHERE id = ?")
    .run(makeExamCode(), exam.id);
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(
  session({
    name: "institution_exam_admin",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(__dirname));

function cleanText(value, maxLength = 10000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanCandidateName(value) {
  return cleanText(value, 120).replace(/\s+/g, " ");
}

function candidateKey(value) {
  return cleanCandidateName(value)
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function getAdmin(req, res, next) {
  if (!req.session || req.session.isAdmin !== true) {
    return res.status(401).json({
      error: "Admin login required."
    });
  }

  next();
}

function wordTokens(text) {
  // Punctuation and whitespace are excluded from word comparison.
  // Capitalization remains significant.
  return String(text ?? "").match(
    /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
  ) || [];
}

function timestampMs(value) {
  if (!value) return NaN;

  const normalized = String(value).includes("T")
    ? String(value)
    : String(value).replace(" ", "T") + "Z";

  return Date.parse(normalized);
}

function examForClient(exam) {
  return {
    id: exam.id,
    code: exam.code,
    title: exam.title,
    language: exam.language,
    duration_min: exam.duration_min,
    wpm: exam.wpm,
    full_marks: exam.full_marks,
    sourceText: exam.source_text,
    status: exam.status,
    created_at: exam.created_at
  };
}

/*
  MARKING RULES

  1. Only exact, case-sensitive matches to the corresponding original
     words earn marks.
  2. Punctuation and spacing do not affect marks.
  3. Extra words never earn marks or cause marking deductions.
  4. An omitted original word cannot earn marks.
  5. Timing never affects marks.
  6. Final marks = correct words / original words * full marks.
*/

function alignWords(sourceWords, typedWords) {
  const n = sourceWords.length;
  const m = typedWords.length;

  // Avoid excessive memory use for unusually large paragraphs.
  if (n * m > 2500000) {
    const pairs = [];
    const max = Math.max(n, m);

    for (let i = 0; i < max; i++) {
      pairs.push({
        sourceIndex: i < n ? i : null,
        typedIndex: i < m ? i : null,
        correct:
          i < n &&
          i < m &&
          sourceWords[i] === typedWords[i],
        extra: i >= n
      });
    }

    return pairs;
  }

  // Edit-distance alignment prevents an inserted extra word from
  // automatically shifting all later words out of alignment.
  const dp = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1)
  );

  const direction = Array.from(
    { length: n + 1 },
    () => new Uint8Array(m + 1)
  );

  // 1 = compare words, 2 = omitted original word, 3 = extra typed word.
  for (let i = 1; i <= n; i++) {
    dp[i][0] = i;
    direction[i][0] = 2;
  }

  for (let j = 1; j <= m; j++) {
    dp[0][j] = j;
    direction[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const substitutionCost =
        sourceWords[i - 1] === typedWords[j - 1] ? 0 : 1;

      const diagonal =
        dp[i - 1][j - 1] + substitutionCost;

      const omittedSource = dp[i - 1][j] + 1;
      const extraTyped = dp[i][j - 1] + 1;

      let best = diagonal;
      let operation = 1;

      if (omittedSource < best) {
        best = omittedSource;
        operation = 2;
      }

      if (extraTyped < best) {
        best = extraTyped;
        operation = 3;
      }

      dp[i][j] = best;
      direction[i][j] = operation;
    }
  }

  const reversed = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const operation = direction[i][j];

    if (i > 0 && j > 0 && operation === 1) {
      reversed.push({
        sourceIndex: i - 1,
        typedIndex: j - 1,
        correct: sourceWords[i - 1] === typedWords[j - 1],
        extra: false
      });

      i--;
      j--;
    } else if (i > 0 && (j === 0 || operation === 2)) {
      reversed.push({
        sourceIndex: i - 1,
        typedIndex: null,
        correct: false,
        extra: false
      });

      i--;
    } else {
      reversed.push({
        sourceIndex: null,
        typedIndex: j - 1,
        correct: false,
        extra: true
      });

      j--;
    }
  }

  return reversed.reverse();
}

function calculateResult(sourceText, typedText, fullMarks) {
  const sourceWords = wordTokens(sourceText);
  const typedWords = wordTokens(typedText);
  const alignment = alignWords(sourceWords, typedWords);

  let correctWords = 0;
  let mistakeWords = 0;
  let extraWords = 0;

  for (const item of alignment) {
    if (
      item.sourceIndex !== null &&
      item.typedIndex !== null
    ) {
      if (item.correct) {
        correctWords++;
      } else {
        mistakeWords++;
      }
    } else if (
      item.sourceIndex !== null &&
      item.typedIndex === null
    ) {
      // An original word was omitted.
      mistakeWords++;
    } else if (
      item.sourceIndex === null &&
      item.typedIndex !== null
    ) {
      // Extra words count in total typed words, but not marking.
      extraWords++;
    }
  }

  const originalWordCount = sourceWords.length;
  const totalTypedWords = typedWords.length;
  const maximumMarks = Number(fullMarks) || 0;

  const accuracy = originalWordCount
    ? Math.round(
        (correctWords / originalWordCount) * 10000
      ) / 100
    : 0;

  const marks = originalWordCount
    ? Math.min(
        maximumMarks,
        (correctWords / originalWordCount) * maximumMarks
      )
    : 0;

  return {
    totalWords: totalTypedWords,
    requiredWords: originalWordCount,
    correctWords,
    mistakeWords,
    extraWords,
    accuracy,
    finalMarks: Math.round(marks * 100) / 100,
    sourceWords,
    typedWords,
    alignment
  };
}

// Automatically delete exams, registrations and results after 15 days.
function deleteExpiredData() {
  const cutoff = new Date(
    Date.now() - FIFTEEN_DAYS_MS
  ).toISOString().replace("T", " ").slice(0, 19);

  db.prepare("DELETE FROM exams WHERE created_at < ?")
    .run(cutoff);

  // Additional cleanup for older databases.
  db.prepare(`
    DELETE FROM results
    WHERE exam_id NOT IN (SELECT id FROM exams)
       OR created_at < ?
  `).run(cutoff);

  db.prepare(`
    DELETE FROM registrations
    WHERE exam_id NOT IN (SELECT id FROM exams)
       OR created_at < ?
  `).run(cutoff);
}

deleteExpiredData();

setInterval(() => {
  try {
    deleteExpiredData();
  } catch (error) {
    console.error("Automatic cleanup failed:", error.message);
  }
}, 60 * 60 * 1000).unref();

// ADMIN LOGIN
app.post("/api/admin/login", (req, res) => {
  const username = cleanText(req.body?.username, 120);
  const password = String(req.body?.password ?? "");

  if (
    username === ADMIN_USERNAME &&
    password === ADMIN_PASSWORD
  ) {
    req.session.isAdmin = true;
    req.session.adminUsername = username;

    return req.session.save((error) => {
      if (error) {
        return res.status(500).json({
          error: "Could not start admin session."
        });
      }

      res.json({
        success: true,
        username
      });
    });
  }

  res.status(401).json({
    error: "Invalid username or password."
  });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("institution_exam_admin");
    res.json({ success: true });
  });
});

app.get("/api/admin/me", getAdmin, (req, res) => {
  res.json({
    success: true,
    username: req.session.adminUsername || ADMIN_USERNAME
  });
});

// CREATE EXAM
app.post("/api/admin/exams", getAdmin, (req, res) => {
  const title = cleanText(req.body?.title, 200);
  const language = cleanText(
    req.body?.language || "English",
    40
  );

  const durationMin = Math.max(
    1,
    Math.min(
      240,
      Number.parseInt(req.body?.duration_min, 10) || 5
    )
  );

  const wpm = Math.max(
    1,
    Math.min(
      300,
      Number.parseInt(req.body?.wpm, 10) || 25
    )
  );

  const fullMarks = Number(req.body?.full_marks);

  const sourceText = cleanText(
    req.body?.sourceText ?? req.body?.source_text,
    50000
  );

  if (!title || !sourceText || wordTokens(sourceText).length === 0) {
    return res.status(400).json({
      error: "Exam title and original paragraph are required."
    });
  }

  if (
    !Number.isFinite(fullMarks) ||
    fullMarks <= 0 ||
    fullMarks > 100000
  ) {
    return res.status(400).json({
      error: "Full marks must be a positive number."
    });
  }

  let code;

  for (let attempt = 0; attempt < 10; attempt++) {
    code = makeExamCode();

    if (!db.prepare(
      "SELECT id FROM exams WHERE code = ?"
    ).get(code)) {
      break;
    }
  }

  try {
    const result = db.prepare(`
      INSERT INTO exams
        (code, title, language, duration_min, wpm,
         full_marks, source_text, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      code,
      title,
      language,
      durationMin,
      wpm,
      fullMarks,
      sourceText
    );

    const exam = db.prepare(
      "SELECT * FROM exams WHERE id = ?"
    ).get(result.lastInsertRowid);

    res.json({
      success: true,
      exam: examForClient(exam),
      code
    });
  } catch (error) {
    console.error("Create exam failed:", error.message);

    res.status(500).json({
      error: "Could not create the examination."
    });
  }
});

// LIST EXAMS
app.get("/api/admin/exams", getAdmin, (req, res) => {
  const exams = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM results r
       WHERE r.exam_id = e.id) AS resultCount,
      (SELECT COUNT(*) FROM registrations g
       WHERE g.exam_id = e.id) AS registrationCount
    FROM exams e
    ORDER BY e.created_at DESC, e.id DESC
  `).all().map((exam) => ({
    ...examForClient(exam),
    resultCount: exam.resultCount,
    registrationCount: exam.registrationCount
  }));

  res.json({ success: true, exams });
});

// LIST RESULTS
app.get("/api/admin/results", getAdmin, (req, res) => {
  const examId = Number.parseInt(req.query.exam_id, 10);

  const rows =
    Number.isInteger(examId) && examId > 0
      ? db.prepare(`
          SELECT r.*, e.code, e.title, e.language,
                 e.full_marks, e.source_text
          FROM results r
          JOIN exams e ON e.id = r.exam_id
          WHERE r.exam_id = ?
          ORDER BY r.candidate_name COLLATE NOCASE ASC,
                   r.candidate_name ASC
        `).all(examId)
      : db.prepare(`
          SELECT r.*, e.code, e.title, e.language,
                 e.full_marks, e.source_text
          FROM results r
          JOIN exams e ON e.id = r.exam_id
          ORDER BY r.created_at DESC,
                   r.candidate_name COLLATE NOCASE ASC
        `).all();

  res.json({
    success: true,
    results: rows.map((r) => ({
      id: r.id,
      exam_id: r.exam_id,
      candidate_name: r.candidate_name,
      candidateName: r.candidate_name,
      total_words: r.total_words,
      totalWords: r.total_words,
      mistake_words: r.mistake_words,
      mistakeWords: r.mistake_words,
      correct_words: r.correct_words,
      correctWords: r.correct_words,
      accuracy: r.accuracy,
      final_marks: r.final_marks,
      finalMarks: r.final_marks,
      typed_text: r.typed_text,
      typedText: r.typed_text,
      reason: r.reason,
      created_at: r.created_at,
      code: r.code,
      title: r.title,
      language: r.language,
      full_marks: r.full_marks,
      sourceText: r.source_text
    }))
  });
});

// DOWNLOAD FULL RESULT-SHEET DATA
app.get(
  "/api/admin/results/download",
  getAdmin,
  (req, res) => {
    const examId = Number.parseInt(req.query.exam_id, 10);

    if (!Number.isInteger(examId) || examId <= 0) {
      return res.status(400).json({
        error: "A valid exam_id is required."
      });
    }

    const exam = db.prepare(
      "SELECT * FROM exams WHERE id = ?"
    ).get(examId);

    if (!exam) {
      return res.status(404).json({
        error: "Examination not found."
      });
    }

    const results = db.prepare(`
      SELECT * FROM results
      WHERE exam_id = ?
      ORDER BY candidate_name COLLATE NOCASE ASC,
               candidate_name ASC
    `).all(examId);

    res.json({
      success: true,
      exam: examForClient(exam),
      results: results.map((r) => ({
        id: r.id,
        candidate_name: r.candidate_name,
        total_words: r.total_words,
        mistake_words: r.mistake_words,
        correct_words: r.correct_words,
        accuracy: r.accuracy,
        final_marks: r.final_marks,
        typed_text: r.typed_text,
        reason: r.reason,
        created_at: r.created_at
      }))
    });
  }
);

// DELETE ENTIRE EXAM, INCLUDING ITS CODE AND RESULTS
app.delete("/api/admin/exams/:id", getAdmin, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: "Invalid examination ID."
    });
  }

  const exam = db.prepare(
    "SELECT id FROM exams WHERE id = ?"
  ).get(id);

  if (!exam) {
    return res.status(404).json({
      error: "Examination not found."
    });
  }

  const removeAll = db.transaction(() => {
    db.prepare("DELETE FROM results WHERE exam_id = ?").run(id);
    db.prepare(
      "DELETE FROM registrations WHERE exam_id = ?"
    ).run(id);
    db.prepare("DELETE FROM exams WHERE id = ?").run(id);
  });

  removeAll();

  res.json({
    success: true,
    message: "Examination, code, registrations and results deleted."
  });
});

// CANDIDATE ACCESS AND REGISTRATION
app.post("/api/exam/access", (req, res) => {
  const code = cleanText(req.body?.code, 80).toUpperCase();

  const candidateName = cleanCandidateName(
    req.body?.candidateName ??
    req.body?.candidate_name ??
    req.body?.name
  );

  if (!code || !candidateName) {
    return res.status(400).json({
      error: "Enter the examination code and candidate name."
    });
  }

  const exam = db.prepare(`
    SELECT * FROM exams
    WHERE code = ? AND status = 'active'
  `).get(code);

  if (!exam) {
    return res.status(404).json({
      error: "Invalid or unavailable examination code."
    });
  }

  const nameKey = candidateKey(candidateName);

  const existingRegistration = db.prepare(`
    SELECT id, status FROM registrations
    WHERE exam_id = ? AND candidate_name_key = ?
  `).get(exam.id, nameKey);

  const existingResult = db.prepare(`
    SELECT id FROM results
    WHERE exam_id = ? AND lower(candidate_name) = lower(?)
  `).get(exam.id, candidateName);

  if (existingRegistration || existingResult) {
    return res.status(409).json({
      error: "This candidate name has already been registered or submitted for this examination."
    });
  }

  try {
    const inserted = db.prepare(`
      INSERT INTO registrations
        (exam_id, candidate_name, candidate_name_key, status)
      VALUES (?, ?, ?, 'registered')
    `).run(exam.id, candidateName, nameKey);

    res.json({
      success: true,
      registrationId: inserted.lastInsertRowid,
      candidateName,
      exam: examForClient(exam),
      title: exam.title,
      language: exam.language,
      duration_min: exam.duration_min,
      wpm: exam.wpm,
      fullMarks: exam.full_marks,
      sourceText: exam.source_text,
      requiredWords: wordTokens(exam.source_text).length
    });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({
        error: "This candidate name has already been registered for this examination."
      });
    }

    console.error("Candidate access failed:", error.message);

    res.status(500).json({
      error: "Could not register candidate."
    });
  }
});

// START EXAMINATION TIMER
app.post("/api/exam/start", (req, res) => {
  const examId = Number.parseInt(
    req.body?.examId ?? req.body?.exam_id,
    10
  );

  const registrationId = Number.parseInt(
    req.body?.registrationId ?? req.body?.registration_id,
    10
  );

  const candidateName = cleanCandidateName(
    req.body?.candidateName ?? req.body?.candidate_name
  );

  if (
    !Number.isInteger(examId) ||
    !Number.isInteger(registrationId) ||
    !candidateName
  ) {
    return res.status(400).json({
      error: "Candidate registration information is missing."
    });
  }

  const registration = db.prepare(`
    SELECT * FROM registrations
    WHERE id = ? AND exam_id = ?
  `).get(registrationId, examId);

  const exam = db.prepare(`
    SELECT * FROM exams
    WHERE id = ? AND status = 'active'
  `).get(examId);

  if (
    !registration ||
    !exam ||
    candidateKey(registration.candidate_name) !==
      candidateKey(candidateName)
  ) {
    return res.status(404).json({
      error: "Candidate registration or examination not found."
    });
  }

  if (
    registration.status === "submitted" ||
    registration.status === "expired"
  ) {
    return res.status(409).json({
      error: "This examination attempt is no longer available."
    });
  }

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + exam.duration_min * 60 * 1000
  );

  db.prepare(`
    UPDATE registrations
    SET status = 'started', started_at = ?, expires_at = ?
    WHERE id = ?
  `).run(
    now.toISOString(),
    expiresAt.toISOString(),
    registrationId
  );

  res.json({
    success: true,
    exam: examForClient(exam),
    registrationId,
    candidateName: registration.candidate_name,
    sourceText: exam.source_text,
    title: exam.title,
    language: exam.language,
    duration_min: exam.duration_min,
    wpm: exam.wpm,
    fullMarks: exam.full_marks,
    requiredWords: wordTokens(exam.source_text).length,
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    serverTime: now.toISOString()
  });
});

// TIMER SYNCHRONIZATION
app.post("/api/exam/heartbeat", (req, res) => {
  const registrationId = Number.parseInt(
    req.body?.registrationId ?? req.body?.registration_id,
    10
  );

  const registration = db.prepare(`
    SELECT g.*, e.duration_min, e.status AS exam_status
    FROM registrations g
    JOIN exams e ON e.id = g.exam_id
    WHERE g.id = ?
  `).get(registrationId);

  if (!registration) {
    return res.status(404).json({
      error: "Examination attempt not found."
    });
  }

  if (
    registration.status === "submitted" ||
    registration.status === "expired"
  ) {
    return res.json({
      success: true,
      ended: true,
      serverTime: new Date().toISOString()
    });
  }

  const now = Date.now();
  const expires = timestampMs(registration.expires_at);

  if (
    registration.status === "started" &&
    Number.isFinite(expires) &&
    now >= expires
  ) {
    db.prepare(
      "UPDATE registrations SET status = 'expired' WHERE id = ?"
    ).run(registrationId);

    return res.json({
      success: true,
      ended: true,
      expired: true,
      serverTime: new Date().toISOString()
    });
  }

  res.json({
    success: true,
    ended: false,
    expiresAt: registration.expires_at,
    serverTime: new Date().toISOString()
  });
});

// SUBMIT RESULT
app.post("/api/exam/submit", (req, res) => {
  const examId = Number.parseInt(
    req.body?.examId ?? req.body?.exam_id,
    10
  );

  const registrationId = Number.parseInt(
    req.body?.registrationId ?? req.body?.registration_id,
    10
  );

  const candidateName = cleanCandidateName(
    req.body?.candidateName ?? req.body?.candidate_name
  );

  const typedText = String(
    req.body?.typedText ?? req.body?.typed_text ?? ""
  );

  const reason = cleanText(req.body?.reason || "", 300);

  if (
    !Number.isInteger(examId) ||
    !Number.isInteger(registrationId) ||
    !candidateName
  ) {
    return res.status(400).json({
      error: "Candidate submission information is missing."
    });
  }

  const registration = db.prepare(`
    SELECT * FROM registrations
    WHERE id = ? AND exam_id = ?
  `).get(registrationId, examId);

  const exam = db.prepare(
    "SELECT * FROM exams WHERE id = ?"
  ).get(examId);

  if (
    !registration ||
    !exam ||
    candidateKey(registration.candidate_name) !==
      candidateKey(candidateName)
  ) {
    return res.status(404).json({
      error: "Candidate registration or examination not found."
    });
  }

  const priorResult = db.prepare(`
    SELECT id FROM results
    WHERE exam_id = ? AND lower(candidate_name) = lower(?)
  `).get(examId, candidateName);

  if (registration.status === "submitted" || priorResult) {
    return res.status(409).json({
      error: "This candidate has already submitted a result."
    });
  }

  if (!registration.started_at || !registration.expires_at) {
    return res.status(409).json({
      error: "The examination has not been started."
    });
  }

  // The timer never changes marks. The browser must stop typing at expiry.
  // The server still scores the submitted text using the original paragraph.
  const scored = calculateResult(
    exam.source_text,
    typedText,
    exam.full_marks
  );

  const now = new Date().toISOString();

  try {
    const insert = db.prepare(`
      INSERT INTO results
        (exam_id, candidate_name, total_words, mistake_words,
         correct_words, accuracy, final_marks, typed_text,
         reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      examId,
      registration.candidate_name,
      scored.totalWords,
      scored.mistakeWords,
      scored.correctWords,
      scored.accuracy,
      scored.finalMarks,
      typedText,
      reason,
      now
    );

    db.prepare(`
      UPDATE registrations
      SET status = 'submitted'
      WHERE id = ?
    `).run(registrationId);

    res.json({
      success: true,
      resultId: insert.lastInsertRowid,
      candidateName: registration.candidate_name,
      title: exam.title,
      language: exam.language,
      totalWords: scored.totalWords,
      requiredWords: scored.requiredWords,
      correctWords: scored.correctWords,
      mistakeWords: scored.mistakeWords,
      extraWords: scored.extraWords,
      accuracy: scored.accuracy,
      fullMarks: exam.full_marks,
      finalMarks: scored.finalMarks,
      sourceText: exam.source_text,
      typedText,
      reason,
      createdAt: now
    });
  } catch (error) {
    console.error("Submit result failed:", error.message);

    res.status(500).json({
      error: "Could not save the examination result."
    });
  }
});

// BROWSER STORAGE API (replaces Firebase). Used by index.html on any Node host.
// Data is kept in the same SQLite file as the rest of the exam data.
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    path TEXT PRIMARY KEY,
    coll TEXT NOT NULL,
    data TEXT NOT NULL
  );
`);

const kvGet = db.prepare("SELECT data FROM kv_store WHERE path = ?");
const kvSet = db.prepare(
  "INSERT INTO kv_store (path, coll, data) VALUES (?, ?, ?) " +
  "ON CONFLICT(path) DO UPDATE SET data = excluded.data"
);
const kvAdd = db.prepare(
  "INSERT OR IGNORE INTO kv_store (path, coll, data) VALUES (?, ?, ?)"
);
const kvDel = db.prepare("DELETE FROM kv_store WHERE path = ?");
const kvList = db.prepare(
  "SELECT path, data FROM kv_store WHERE coll = ? AND substr(path, 1, ?) = ?"
);

const sqliteStorage = {
  async get(p) {
    const row = kvGet.get(p);
    return row ? JSON.parse(row.data) : null;
  },
  async set(p, obj) {
    kvSet.run(p, p.split("/")[0], JSON.stringify(obj));
  },
  async del(p) {
    kvDel.run(p);
  },
  async setIfAbsent(p, obj) {
    return kvAdd.run(p, p.split("/")[0], JSON.stringify(obj)).changes === 1;
  },
  async list(coll, prefix) {
    const pfx = prefix || coll + "/";
    return kvList.all(coll, pfx.length, pfx).map((row) => ({
      id: row.path.slice(coll.length + 1),
      data: JSON.parse(row.data)
    }));
  }
};

const browserStore = createStore(
  {
    adminName: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    secret: SESSION_SECRET
  },
  sqliteStorage
);

app.post("/api/store", async (req, res) => {
  const out = await browserStore.handle(
    {
      authorization: req.get("authorization"),
      candidateId: req.get("x-candidate-id")
    },
    req.body
  );

  res.set("Cache-Control", "no-store");
  res.status(out.status).json(out.body);
});

// Health check for deployment.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Serve the opening page.
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `Institution Typing Examination server running on port ${PORT}`
  );
});
