const CATEGORIES = [
  "Account Opening",
  "Billing Issue",
  "Account Access",
  "Transaction Inquiry",
  "Card Services",
  "Account Statement",
  "Loan Inquiry",
  "General Information",
];

// keyword map for candidate mapping
const KEYWORDS = {
  "Account Opening": ["open account", "new account", "open a checking", "apply account", "signup"],
  "Billing Issue": ["charge", "bill", "billing", "invoice", "overcharged", "refund"],
  "Account Access": ["login", "sign in", "password", "locked out", "can't access", "unlock"],
  "Transaction Inquiry": ["transaction", "transfer", "withdrawal", "payment", "pending", "unauthorized", "charge"],
  "Card Services": ["card", "credit card", "debit card", "lost card", "stolen card", "block my card", "replace card"],
  "Account Statement": ["statement", "e-statement", "pdf statement", "monthly statement", "download statement"],
  "Loan Inquiry": ["loan", "mortgage", "interest rate", "apply for loan", "loan payment"],
  "General Information": ["hours", "location", "branch", "interest", "contact", "information"],
};

// details to extract according to category
const DETAILS_BY_CATEGORY = {
  "Transaction Inquiry": ["transaction_date (Required)", "amount (Required)", "merchant (Optional)", "card_last4 (Optional)"],
  "Card Services": ["card_last4 (Required)", "date_lost_or_stolen (Optional)"],
  "Account Access": ["preferred_contact_method (Optional)", "last_successful_login (Optional)"],
  "Billing Issue": ["invoice_number (Optional)", "amount (Required)", "billing_period (Optional)"],
  "Account Opening": ["account_type (Required)", "full_name (Required)", "id_document (Required)"],
  "Account Statement": ["statement_period (Required)", "email (Optional)"],
  "Loan Inquiry": ["loan_type (Required)", "loan_account_number (Optional)"],
  "General Information": [],
};

function norm(s) {
  return (s || "").toLowerCase();
}

function interpretIntent(query) {
  const q = query.trim();
  const lower = q.toLowerCase();
  const firstSentence = q.split(/[.?!\n]/)[0];
  let intent;
  if (/how|why|when|what|can i|could i|do i|is it|are you|please/i.test(lower)) {
    intent = `Asks: ${firstSentence.trim()}`;
  } else if (/i am|i've|i have|my|we have|we're|we are/i.test(lower)) {
    intent = `Reports: ${firstSentence.trim()}`;
  } else {
    intent = `Requests: ${firstSentence.trim()}`;
  }
  return intent;
}

// Step 2: Map to candidate categories
function mapToCategories(query, maxCandidates = 3) {
  const scores = new Map();
  const q = norm(query);
  for (const cat of CATEGORIES) {
    scores.set(cat, 0);
    const kws = KEYWORDS[cat] || [];
    for (const kw of kws) {
      if (q.includes(kw)) {
        scores.set(cat, scores.get(cat) + 1);
      }
    }
  }
  // Check for numbers/amounts => favor Transaction or Billing
  if (/\$\s*\d+|\d+\.\d{2}/.test(q) || /\b(amount|charged|charge|refund)\b/.test(q)) {
    scores.set("Transaction Inquiry", scores.get("Transaction Inquiry") + 1);
    scores.set("Billing Issue", scores.get("Billing Issue") + 1);
  }
  if (/\b(password|login|sign in|locked|unlock|2fa|two[- ]factor)\b/.test(q)) {
    scores.set("Account Access", scores.get("Account Access") + 2);
  }
  // Build for sorted list
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  // Filter zeros out
  const filtered = sorted.filter(([, sc]) => sc > 0);
  const candidates = filtered.slice(0, maxCandidates).map(([cat, sc]) => ({ category: cat, score: sc, reason: `matched keywords (${sc})` }));
  // If no matches, default to General Information
  if (candidates.length === 0) {
    return [{ category: "General Information", score: 0, reason: "no matching keywords" }];
  }
  return candidates;
}

// Step 3: Choose best category 
function chooseCategory(candidates, query) {
  if (!candidates || candidates.length === 0) return { category: "General Information", reason: "fallback" };
  // sort by score desc
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  //  if both Transaction and Card Services present and "card" in query, choose Card Services
  const q = norm(query);
  if (candidates.length > 1) {
    const names = candidates.map(c => c.category);
    if (names.includes("Card Services") && q.includes("card")) {
      return { category: "Card Services", reason: "query mentions card" };
    }
    if (names.includes("Transaction Inquiry") && q.match(/\$\s*\d+|\d+\.\d{2}/)) {
      return { category: "Transaction Inquiry", reason: "includes amount pattern" };
    }
  }
  return { category: top.category, reason: top.reason };
}

// Step 4: Extract additional details 
function extractDetails(query, chosenCategory) {
  const detailsTemplate = DETAILS_BY_CATEGORY[chosenCategory] || [];
  const extracted = { required: [], optional: [] };

  const q = query;
  // detect amounts
  const amountMatch = q.match(/\$\s*[\d,]+(?:\.\d{2})?|\b\d+\.\d{2}\b/);
  if (amountMatch) {
    extracted.required.push(`amount: ${amountMatch[0]}`);
  }
  // detect date
  const dateMatch = q.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9} \d{1,2}(?:,\s*\d{4})?)\b/);
  if (dateMatch) {
    extracted.required.push(`transaction_date: ${dateMatch[0]}`);
  }
  // detect last4 digits
  const last4 = q.match(/\b\d{4}\b/);
  if (last4) {
    extracted.optional.push(`card_last4: ${last4[0]}`);
  }
  // detect invoice or transaction id
  const txid = q.match(/\b(tx|txn|transaction)[-_]?[A-Za-z0-9]{4,}\b/i);
  if (txid) {
    extracted.optional.push(`transaction_id: ${txid[0]}`);
  }

  // For each category, decide which are required vs optional based on template
  const requiredList = [];
  const optionalList = [];
  for (const item of detailsTemplate) {
    if (item.includes("(Required)")) requiredList.push(item.replace(" (Required)", ""));
    if (item.includes("(Optional)")) optionalList.push(item.replace(" (Optional)", ""));
  }

  // Create final lists: prefer extracted values; otherwise list required missing
  const missingRequired = [];
  // Map extracted keys into normalized names
  const extractedKeys = {};
  for (const r of extracted.required) {
    const [k,v] = r.split(":",2).map(s => s.trim());
    extractedKeys[k] = v;
  }
  for (const r of extracted.optional) {
    const [k,v] = r.split(":",2).map(s => s.trim());
    extractedKeys[k] = v;
  }

  // build required details result
  const requiredResults = [];
  for (const req of requiredList) {
    if (extractedKeys[req]) {
      requiredResults.push(`${req}: ${extractedKeys[req]}`);
    } else {
      missingRequired.push(req);
      requiredResults.push(`${req}: MISSING`);
    }
  }
  const optionalResults = [];
  for (const opt of optionalList) {
    if (extractedKeys[opt]) {
      optionalResults.push(`${opt}: ${extractedKeys[opt]}`);
    } else {
      optionalResults.push(`${opt}: not provided`);
    }
  }

  // If category has no templates, return detected extracted fields
  if (requiredList.length === 0 && optionalList.length === 0) {
    return { required: extracted.required, optional: extracted.optional, missingRequired: [] };
  }

  return { required: requiredResults, optional: optionalResults, missingRequired };
}

// Step 5: Generate short response
function generateReply(query, chosenCategory, details) {
  // If required missing, ask for them
  if (details.missingRequired && details.missingRequired.length > 0) {
    const missing = details.missingRequired.join(", ");
    return `I can help with ${chosenCategory.toLowerCase()}. Please provide the following required details: ${missing}.`;
  }

  // Otherwise, produce a short action-oriented reply
  switch (chosenCategory) {
    case "Transaction Inquiry":
      return `Thanks — I see this is a transaction inquiry. I will look into the transaction and get back; could you confirm the amount and date if not already provided?`;
    case "Card Services":
      return `Sorry to hear about your card. I can help block and replace it. Please confirm the last 4 digits of the card.`;
    case "Account Access":
      return `I can help you regain access. Would you like me to send a password reset link or start an account verification flow?`;
    case "Billing Issue":
      return `Thanks — I can review the billing issue and raise a dispute if needed. Please confirm the transaction amount and invoice number (if available).`;
    case "Account Opening":
      return `We can help open a new account. Please tell us the account type (checking/savings) and full name to begin the application.`;
    case "Account Statement":
      return `I can provide the statement. Which statement period would you like (e.g., March 2025)?`;
    case "Loan Inquiry":
      return `I can help with loan information. Are you asking about repayments, interest rates, or applying for a new loan?`;
    default:
      return `Thanks for contacting us. Can you please provide a bit more detail so we can help (e.g., account number last 4 digits or date of transaction)?`;
  }
}

// function to run the prompt chain
async function runPromptChain(customerQuery) {
  if (typeof customerQuery !== "string") {
    throw new Error("customerQuery must be a string");
  }
  // Stage 1
  const interpretedIntent = interpretIntent(customerQuery);

  // Stage 2
  const candidates = mapToCategories(customerQuery);
  // Format candidates as short strings
  const candidateCategories = candidates.map(c => `${c.category} — ${c.reason}`);

  // Stage 3
  const chosen = chooseCategory(candidates, customerQuery);
  const chosenCategory = `${chosen.category} — ${chosen.reason}`;

  // Stage 4
  const extractedDetails = extractDetails(customerQuery, chosen.category);

  // Stage 5
  const finalReply = generateReply(customerQuery, chosen.category, extractedDetails);

  // Return list of intermediate outputs (5 entries)
  return [
    interpretedIntent,          // 1. interpreted intent (string)
    candidateCategories,        // 2. candidate categories (array of strings)
    chosenCategory,             // 3. chosen category (string)
    extractedDetails,           // 4. extracted details (object)
    finalReply                  // 5. final reply (string)
  ];
}

// Export for usage (Node.js)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { runPromptChain };
}

// If run directly, simple CLI demo
if (require.main === module) {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.log("Usage: node prompt-chain.js \"<customer query>\"");
    process.exit(1);
  }
  (async () => {
    const out = await runPromptChain(input);
    console.log("=== Prompt chain outputs ===");
    console.log("1) Interpreted intent:", out[0]);
    console.log("2) Candidate categories:", out[1]);
    console.log("3) Chosen category:", out[2]);
    console.log("4) Extracted details:", JSON.stringify(out[3], null, 2));
    console.log("5) Final reply:", out[4]);
  })();
}
