/**
 * briaz — Sales Lead Contact Manager
 * A micro-SaaS for storing and managing sales leads (contacts + addresses).
 *
 * Mandatory Requirements Coverage:
 * - Component Design: Reusable ContactCard, ContactForm, LeadList, Dashboard, etc.
 * - State Management: React Context (AuthContext, LeadsContext) + useReducer
 * - Authentication: Sign up / sign in (email+password) via Supabase Auth
 * - Routing: TanStack Router with nested routes + protected routes
 * - Server Communication: Supabase CRUD for leads table with RLS
 */

// ─── Entry point ─────────────────────────────────────────────────────────────
// To run this project:
//   1. npm create vite@latest briaz -- --template react
//   2. npm install @supabase/supabase-js @tanstack/react-router @tanstack/router-devtools
//   3. Replace src/main.jsx and src/App.jsx with the files in this project
//   4. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env
//
// Supabase schema (run in SQL editor):
//   create table leads (
//     id uuid primary key default gen_random_uuid(),
//     user_id uuid references auth.users not null,
//     name text not null,
//     company text,
//     email text,
//     phone text,
//     address text,
//     city text,
//     country text,
//     status text default 'new',
//     notes text,
//     created_at timestamptz default now()
//   );
//   alter table leads enable row level security;
//   create policy "Users manage own leads" on leads
//     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Link,
  useNavigate,
  useSearch,
  Outlet,
} from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════════════════════
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AUTH CONTEXT  (global UI state + auth session)
// ═══════════════════════════════════════════════════════════════════════════════
const AuthContext = createContext(null);

function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_, s) => setSession(s)
    );
    return () => subscription.unsubscribe();
  }, []);

  const signUp = (email, password) =>
    supabase.auth.signUp({ email, password });

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signOut = () => supabase.auth.signOut();

  return (
    <AuthContext.Provider value={{ session, signUp, signIn, signOut, supabase }}>
      {children}
    </AuthContext.Provider>
  );
}

/** @returns {{ session, signUp, signIn, signOut, supabase }} */
function useAuth() {
  return useContext(AuthContext);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. LEADS CONTEXT  (server state + optimistic UI cache)
// ═══════════════════════════════════════════════════════════════════════════════
const LeadsContext = createContext(null);

const STATUS = ["new", "contacted", "qualified", "closed"];

/** Pure reducer — keeps UI state (filter, sort) separate from remote data. */
function leadsReducer(state, action) {
  switch (action.type) {
    case "SET_LEADS":
      return { ...state, leads: action.payload, loading: false };
    case "SET_LOADING":
      return { ...state, loading: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "ADD_LEAD":
      return { ...state, leads: [action.payload, ...state.leads] };
    case "UPDATE_LEAD":
      return {
        ...state,
        leads: state.leads.map((l) =>
          l.id === action.payload.id ? action.payload : l
        ),
      };
    case "DELETE_LEAD":
      return {
        ...state,
        leads: state.leads.filter((l) => l.id !== action.payload),
      };
    case "SET_FILTER":
      return { ...state, filter: action.payload };
    case "SET_SORT":
      return { ...state, sort: action.payload };
    case "SET_SEARCH":
      return { ...state, search: action.payload };
    default:
      return state;
  }
}

const initialLeadsState = {
  leads: [],
  loading: true,
  error: null,
  filter: "all",   // UI state
  sort: "newest",  // UI state
  search: "",      // UI state
};

function LeadsProvider({ children }) {
  const [state, dispatch] = useReducer(leadsReducer, initialLeadsState);
  const { session } = useAuth();

  /** Fetch all leads for current user */
  const fetchLeads = useCallback(async () => {
    if (!session) return;
    dispatch({ type: "SET_LOADING", payload: true });
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) dispatch({ type: "SET_ERROR", payload: error.message });
    else dispatch({ type: "SET_LEADS", payload: data });
  }, [session]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  /** Create a new lead */
  async function createLead(values) {
    const { data, error } = await supabase
      .from("leads")
      .insert([{ ...values, user_id: session.user.id }])
      .select()
      .single();
    if (error) throw error;
    dispatch({ type: "ADD_LEAD", payload: data });
    return data;
  }

  /** Update an existing lead */
  async function updateLead(id, values) {
    const { data, error } = await supabase
      .from("leads")
      .update(values)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    dispatch({ type: "UPDATE_LEAD", payload: data });
    return data;
  }

  /** Delete a lead */
  async function deleteLead(id) {
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) throw error;
    dispatch({ type: "DELETE_LEAD", payload: id });
  }

  /** Derived: filtered + sorted + searched leads */
  const visibleLeads = (() => {
    let list = [...state.leads];
    if (state.filter !== "all") list = list.filter((l) => l.status === state.filter);
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(
        (l) =>
          l.name?.toLowerCase().includes(q) ||
          l.company?.toLowerCase().includes(q) ||
          l.email?.toLowerCase().includes(q) ||
          l.city?.toLowerCase().includes(q)
      );
    }
    if (state.sort === "oldest")
      list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (state.sort === "name")
      list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  })();

  return (
    <LeadsContext.Provider
      value={{ ...state, visibleLeads, dispatch, createLead, updateLead, deleteLead, fetchLeads }}
    >
      {children}
    </LeadsContext.Provider>
  );
}

function useLeads() {
  return useContext(LeadsContext);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DESIGN TOKENS & GLOBAL STYLES  (injected once)
// ═══════════════════════════════════════════════════════════════════════════════
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #f4f2ee;
    --surface: #ffffff;
    --surface2: #faf9f6;
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.15);
    --text: #18171c;
    --text-muted: #6b6872;
    --text-faint: #a8a5b0;
    --accent: #2d6a4f;
    --accent-light: #d8f3dc;
    --accent-text: #1a3d2b;
    --red: #c0392b;
    --red-light: #fdecea;
    --amber: #d97706;
    --amber-light: #fef3c7;
    --blue: #1d6fa4;
    --blue-light: #dbeafe;
    --radius-sm: 6px;
    --radius: 10px;
    --radius-lg: 16px;
    --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    color: var(--text);
    background: var(--bg);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131215;
      --surface: #1e1d22;
      --surface2: #27252c;
      --border: rgba(255,255,255,0.07);
      --border-strong: rgba(255,255,255,0.14);
      --text: #eeedf2;
      --text-muted: #a09dab;
      --text-faint: #6b6872;
      --accent: #52b788;
      --accent-light: #1b3a2b;
      --accent-text: #b7e4c7;
      --red-light: #2c1414;
      --amber-light: #2a1f08;
      --blue-light: #0f1f30;
    }
  }

  body { min-height: 100vh; }

  h1 { font-family: 'Syne', sans-serif; }

  input, select, textarea {
    font-family: inherit;
    font-size: 14px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    width: 100%;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
  }
  textarea { resize: vertical; min-height: 72px; }

  button { font-family: inherit; cursor: pointer; border: none; outline: none; }

  a { text-decoration: none; color: inherit; }
  * { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
`;

function GlobalStyles() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. REUSABLE COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Primary CTA button */
function Btn({ children, onClick, type = "button", variant = "primary", disabled, style }) {
  const styles = {
    primary: {
      background: "var(--accent)",
      color: "#fff",
      padding: "9px 20px",
      borderRadius: "var(--radius-sm)",
      fontSize: 14,
      fontWeight: 500,
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? "not-allowed" : "pointer",
      transition: "opacity 0.15s, transform 0.1s",
      ...style,
    },
    ghost: {
      background: "transparent",
      color: "var(--text-muted)",
      padding: "8px 16px",
      borderRadius: "var(--radius-sm)",
      fontSize: 14,
      border: "1px solid var(--border-strong)",
      ...style,
    },
    danger: {
      background: "var(--red-light)",
      color: "var(--red)",
      padding: "8px 14px",
      borderRadius: "var(--radius-sm)",
      fontSize: 13,
      fontWeight: 500,
      ...style,
    },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={styles[variant]}
    >
      {children}
    </button>
  );
}

/** Status badge pill */
function StatusBadge({ status }) {
  const map = {
    new: { bg: "var(--blue-light)", color: "var(--blue)" },
    contacted: { bg: "var(--amber-light)", color: "var(--amber)" },
    qualified: { bg: "var(--accent-light)", color: "var(--accent-text)" },
    closed: { bg: "var(--border)", color: "var(--text-muted)" },
  };
  const s = map[status] || map.new;
  return (
    <span
      style={{
        background: s.bg,
        color: s.color,
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 99,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {status}
    </span>
  );
}

/** Avatar circle from initials */
function Avatar({ name, size = 38 }) {
  const initials = name
    ? name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()
    : "?";
  const hue = (name || "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `hsl(${hue}, 38%, 80%)`,
        color: `hsl(${hue}, 38%, 28%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.35,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

/** Inline field label + input wrapper */
function Field({ label, children, error }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </label>
      {children}
      {error && <span style={{ fontSize: 12, color: "var(--red)" }}>{error}</span>}
    </div>
  );
}

/** Card surface */
function Card({ children, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "1.25rem",
        boxShadow: "var(--shadow)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Simple stat tile */
function StatCard({ label, value, accent }) {
  return (
    <div
      style={{
        background: accent ? "var(--accent)" : "var(--surface)",
        border: accent ? "none" : "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "1rem 1.25rem",
        boxShadow: "var(--shadow)",
      }}
    >
      <p style={{ fontSize: 11, fontWeight: 600, color: accent ? "rgba(255,255,255,0.75)" : "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
        {label}
      </p>
      <p style={{ fontSize: 26, fontWeight: 700, color: accent ? "#fff" : "var(--text)", fontFamily: "'Syne', sans-serif" }}>
        {value}
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. LEAD FORM  (create + edit composite component)
// ═══════════════════════════════════════════════════════════════════════════════

const EMPTY_FORM = {
  name: "", company: "", email: "", phone: "",
  address: "", city: "", country: "", status: "new", notes: "",
};

/**
 * ContactForm — handles both create and edit.
 * @param {{ initial?: object, onSubmit: (values) => Promise, onCancel: () => void }} props
 */
function ContactForm({ initial, onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...EMPTY_FORM, ...initial });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  /** Simple field change handler */
  function set(field) {
    return (e) => setValues((v) => ({ ...v, [field]: e.target.value }));
  }

  function validate() {
    const e = {};
    if (!values.name.trim()) e.name = "Name is required";
    if (values.email && !/\S+@\S+\.\S+/.test(values.email))
      e.email = "Enter a valid email";
    return e;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setBusy(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setErrors({ _global: err.message });
    } finally {
      setBusy(false);
    }
  }

  const row = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
  const section = { fontSize: 11, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", padding: "8px 0 4px", borderBottom: "1px solid var(--border)", marginBottom: 4 };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {errors._global && (
        <div style={{ background: "var(--red-light)", color: "var(--red)", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: 13 }}>
          {errors._global}
        </div>
      )}

      <p style={section}>Contact Info</p>
      <div style={row}>
        <Field label="Full Name *" error={errors.name}>
          <input value={values.name} onChange={set("name")} placeholder="Jane Smith" />
        </Field>
        <Field label="Company">
          <input value={values.company} onChange={set("company")} placeholder="Acme Corp" />
        </Field>
      </div>
      <div style={row}>
        <Field label="Email" error={errors.email}>
          <input type="email" value={values.email} onChange={set("email")} placeholder="jane@acme.com" />
        </Field>
        <Field label="Phone">
          <input value={values.phone} onChange={set("phone")} placeholder="+1 555 000 1234" />
        </Field>
      </div>

      <p style={section}>Address</p>
      <Field label="Street Address">
        <input value={values.address} onChange={set("address")} placeholder="123 Main St" />
      </Field>
      <div style={row}>
        <Field label="City">
          <input value={values.city} onChange={set("city")} placeholder="New York" />
        </Field>
        <Field label="Country">
          <input value={values.country} onChange={set("country")} placeholder="USA" />
        </Field>
      </div>

      <p style={section}>Pipeline</p>
      <div style={row}>
        <Field label="Status">
          <select value={values.status} onChange={set("status")}>
            {STATUS.map((s) => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={values.notes} onChange={set("notes")} placeholder="Any relevant context…" />
      </Field>

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" disabled={busy}>{busy ? "Saving…" : initial ? "Save Changes" : "Add Lead"}</Btn>
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CONTACT CARD  (compact list item)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ContactCard — displays a single lead in the list.
 * @param {{ lead: object, onSelect: (id) => void }} props
 */
function ContactCard({ lead, onSelect }) {
  return (
    <Card
      onClick={() => onSelect(lead.id)}
      style={{ cursor: "pointer", transition: "box-shadow 0.15s", ":hover": { boxShadow: "var(--shadow-md)" } }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <Avatar name={lead.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <p style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {lead.name}
            </p>
            <StatusBadge status={lead.status} />
          </div>
          {lead.company && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 2 }}>{lead.company}</p>
          )}
          <p style={{ fontSize: 12, color: "var(--text-faint)" }}>
            {[lead.city, lead.country].filter(Boolean).join(", ") || "No location"}
          </p>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
          {new Date(lead.created_at).toLocaleDateString()}
        </p>
      </div>
      {lead.email && (
        <p style={{ fontSize: 12, color: "var(--accent)", marginTop: 10 }}>{lead.email}</p>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. MODAL  (simple overlay pattern)
// ═══════════════════════════════════════════════════════════════════════════════

function Modal({ title, onClose, children }) {
  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 999, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          borderRadius: "var(--radius-lg)",
          padding: "1.5rem",
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", color: "var(--text-faint)", fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PAGES
// ═══════════════════════════════════════════════════════════════════════════════

// ── 9a. Auth page (sign-in + sign-up) ────────────────────────────────────────
function AuthPage() {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(""); setMsg("");
    if (!email || !password) { setError("Email and password are required"); return; }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error: e } = await signUp(email, password);
        if (e) throw e;
        setMsg("Check your email to confirm your account!");
      } else {
        const { error: e } = await signIn(email, password);
        if (e) throw e;
        navigate({ to: "/dashboard" });
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h1 style={{ fontSize: 36, color: "var(--accent)", letterSpacing: "-0.04em", fontFamily: "'Syne', sans-serif" }}>
            briaz
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Sales lead contact manager
          </p>
        </div>

        <Card>
          <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 20 }}>
            {mode === "signin" ? "Sign in to your account" : "Create an account"}
          </h2>

          {error && (
            <div style={{ background: "var(--red-light)", color: "var(--red)", padding: "9px 13px", borderRadius: "var(--radius-sm)", fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}
          {msg && (
            <div style={{ background: "var(--accent-light)", color: "var(--accent-text)", padding: "9px 13px", borderRadius: "var(--radius-sm)", fontSize: 13, marginBottom: 16 }}>
              {msg}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
            </Field>
            <Field label="Password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
            <Btn type="submit" disabled={busy} style={{ marginTop: 4 }}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign In" : "Create Account"}
            </Btn>
          </form>

          <p style={{ textAlign: "center", marginTop: 18, fontSize: 13, color: "var(--text-muted)" }}>
            {mode === "signin" ? "New here? " : "Have an account? "}
            <button
              onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setMsg(""); }}
              style={{ background: "none", color: "var(--accent)", fontWeight: 500, fontSize: 13 }}
            >
              {mode === "signin" ? "Create account" : "Sign in"}
            </button>
          </p>
        </Card>
      </div>
    </div>
  );
}

// ── 9b. App Shell (sidebar + outlet) ─────────────────────────────────────────
function AppShell() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate({ to: "/" });
  }

  const navItem = (to, label) => (
    <Link
      to={to}
      style={({ isActive }) => ({
        display: "block",
        padding: "8px 14px",
        borderRadius: "var(--radius-sm)",
        fontSize: 14,
        fontWeight: isActive ? 600 : 400,
        color: isActive ? "var(--accent)" : "var(--text-muted)",
        background: isActive ? "var(--accent-light)" : "transparent",
        transition: "background 0.12s",
      })}
    >
      {label}
    </Link>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{ background: "var(--surface)", borderRight: "1px solid var(--border)", padding: "1.5rem 1rem", display: "flex", flexDirection: "column" }}>
        <h1 style={{ fontSize: 22, color: "var(--accent)", letterSpacing: "-0.04em", marginBottom: 28, paddingLeft: 14 }}>
          briaz
        </h1>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          {navItem("/dashboard", "📊  Dashboard")}
          {navItem("/leads", "👥  Leads")}
          {navItem("/leads/new", "＋  Add Lead")}
        </nav>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <p style={{ fontSize: 11, color: "var(--text-faint)", paddingLeft: 14, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.user?.email}
          </p>
          <button
            onClick={handleSignOut}
            style={{ width: "100%", textAlign: "left", padding: "8px 14px", borderRadius: "var(--radius-sm)", background: "none", fontSize: 14, color: "var(--text-muted)" }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main style={{ background: "var(--bg)", overflowY: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}

// ── 9c. Dashboard ─────────────────────────────────────────────────────────────
function DashboardPage() {
  const { leads, loading } = useLeads();

  const byStatus = STATUS.reduce((acc, s) => {
    acc[s] = leads.filter((l) => l.status === s).length;
    return acc;
  }, {});

  const recentLeads = [...leads].slice(0, 5);

  return (
    <div style={{ padding: "2rem" }}>
      <h2 style={{ fontSize: 26, fontFamily: "'Syne', sans-serif", fontWeight: 700, marginBottom: 4 }}>Dashboard</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>Welcome back — here's your pipeline at a glance.</p>

      {loading ? (
        <p style={{ color: "var(--text-faint)" }}>Loading…</p>
      ) : (
        <>
          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 32 }}>
            <StatCard label="Total Leads" value={leads.length} accent />
            <StatCard label="New" value={byStatus.new} />
            <StatCard label="Contacted" value={byStatus.contacted} />
            <StatCard label="Qualified" value={byStatus.qualified} />
            <StatCard label="Closed" value={byStatus.closed} />
          </div>

          {/* Recent activity */}
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>
            Recent Leads
          </h3>
          {recentLeads.length === 0 ? (
            <p style={{ color: "var(--text-faint)", fontSize: 14 }}>No leads yet. <Link to="/leads/new" style={{ color: "var(--accent)" }}>Add your first lead →</Link></p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {recentLeads.map((l) => (
                <ContactCard key={l.id} lead={l} onSelect={() => {}} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 9d. Lead List page ────────────────────────────────────────────────────────
function LeadsPage() {
  const { visibleLeads, loading, filter, sort, search, dispatch } = useLeads();
  const [selectedId, setSelectedId] = useState(null);
  const [editId, setEditId] = useState(null);
  const { updateLead, deleteLead } = useLeads();

  const selected = visibleLeads.find((l) => l.id === selectedId);

  async function handleUpdate(values) {
    await updateLead(editId, values);
    setEditId(null);
  }

  async function handleDelete(id) {
    if (!confirm("Delete this lead?")) return;
    await deleteLead(id);
    setSelectedId(null);
  }

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ fontSize: 26, fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>Leads</h2>
        <Link to="/leads/new">
          <Btn>+ Add Lead</Btn>
        </Link>
      </div>

      {/* Filters toolbar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          placeholder="Search name, company, city…"
          value={search}
          onChange={(e) => dispatch({ type: "SET_SEARCH", payload: e.target.value })}
          style={{ maxWidth: 240, flex: "1 1 160px" }}
        />
        <select
          value={filter}
          onChange={(e) => dispatch({ type: "SET_FILTER", payload: e.target.value })}
          style={{ width: "auto" }}
        >
          <option value="all">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={sort}
          onChange={(e) => dispatch({ type: "SET_SORT", payload: e.target.value })}
          style={{ width: "auto" }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {loading ? (
        <p style={{ color: "var(--text-faint)" }}>Loading leads…</p>
      ) : visibleLeads.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 14 }}>No leads found.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visibleLeads.map((lead) => (
            <ContactCard key={lead.id} lead={lead} onSelect={setSelectedId} />
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && !editId && (
        <Modal title={selected.name} onClose={() => setSelectedId(null)}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20 }}>
            <Avatar name={selected.name} size={52} />
            <div>
              <p style={{ fontWeight: 600, fontSize: 16 }}>{selected.name}</p>
              {selected.company && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>{selected.company}</p>}
              <div style={{ marginTop: 6 }}><StatusBadge status={selected.status} /></div>
            </div>
          </div>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            {[
              ["Email", selected.email],
              ["Phone", selected.phone],
              ["Address", [selected.address, selected.city, selected.country].filter(Boolean).join(", ")],
              ["Notes", selected.notes],
            ].filter(([, v]) => v).map(([k, v]) => (
              <tr key={k}>
                <td style={{ color: "var(--text-faint)", padding: "6px 0", width: 80 }}>{k}</td>
                <td style={{ color: "var(--text)", padding: "6px 0" }}>{v}</td>
              </tr>
            ))}
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
            <Btn variant="danger" onClick={() => handleDelete(selected.id)}>Delete</Btn>
            <Btn variant="ghost" onClick={() => setEditId(selected.id)}>Edit</Btn>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editId && (
        <Modal title="Edit Lead" onClose={() => setEditId(null)}>
          <ContactForm
            initial={selected}
            onSubmit={handleUpdate}
            onCancel={() => setEditId(null)}
          />
        </Modal>
      )}
    </div>
  );
}

// ── 9e. New Lead page ─────────────────────────────────────────────────────────
function NewLeadPage() {
  const { createLead } = useLeads();
  const navigate = useNavigate();

  async function handleCreate(values) {
    await createLead(values);
    navigate({ to: "/leads" });
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 580 }}>
      <h2 style={{ fontSize: 26, fontFamily: "'Syne', sans-serif", fontWeight: 700, marginBottom: 22 }}>
        Add New Lead
      </h2>
      <Card>
        <ContactForm onSubmit={handleCreate} onCancel={() => navigate({ to: "/leads" })} />
      </Card>
    </div>
  );
}

// ── 9f. 404 ───────────────────────────────────────────────────────────────────
function NotFoundPage() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 64, fontFamily: "'Syne', sans-serif", color: "var(--text-faint)" }}>404</p>
      <p style={{ color: "var(--text-muted)" }}>Page not found.</p>
      <Link to="/dashboard"><Btn>Go Home</Btn></Link>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. GUARDS  (protected route wrapper)
// ═══════════════════════════════════════════════════════════════════════════════

/** Renders children only when session exists; redirects to / otherwise. */
function RequireAuth({ children }) {
  const { session } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (session === null) navigate({ to: "/" });
  }, [session, navigate]);

  if (session === undefined) return <p style={{ padding: "2rem", color: "var(--text-faint)" }}>Loading…</p>;
  if (!session) return null;
  return children;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. ROUTER SETUP  (TanStack Router with nested routes)
// ═══════════════════════════════════════════════════════════════════════════════

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const authRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AuthPage,
});

/** Protected shell route — parent for all authenticated pages */
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: () => (
    <RequireAuth>
      <LeadsProvider>
        <AppShell />
      </LeadsProvider>
    </RequireAuth>
  ),
});

/** Nested routes under shell */
const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/dashboard",
  component: DashboardPage,
});

const leadsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/leads",
  component: LeadsPage,
});

// Nested under /leads
const newLeadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/leads/new",
  component: NewLeadPage,
});

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "*",
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  authRoute,
  shellRoute.addChildren([dashboardRoute, leadsRoute, newLeadRoute]),
  notFoundRoute,
]);

const router = createRouter({ routeTree });

// ═══════════════════════════════════════════════════════════════════════════════
// 12. APP ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * App — root component.
 * Provides AuthContext globally; routing and LeadsContext are below.
 */
export default function App() {
  return (
    <>
      <GlobalStyles />
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </>
  );
}
