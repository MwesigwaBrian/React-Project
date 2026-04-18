# briaz — Sales Lead Contact Manager

briaz is a micro-SaaS application for managing sales contacts and addresses. Users can sign up, store leads, track pipeline status, search and filter contacts, and view a dashboard summary — all scoped privately per user.

---

## What Was Built

briaz is a lightweight CRM-style contact manager targeting sales professionals who want a simple, fast tool to capture and track leads without the overhead of full-scale CRM platforms.

Core features:

- Sign up and sign in with email and password using supabase Auth
- Add, view, edit, and delete sales leads
- Each lead stores: name, company, email, phone, street address, city, country, pipeline status, and notes
- Pipeline status tracking: New → Contacted → Qualified → Closed
- Search leads by name, company, email, or city
- Filter by status and sort by date or name
- Dashboard with aggregate counts per pipeline stage
- All data is privately scoped per user via Row Level Security

---

## How Data is Managed

State is split across two React Contexts, keeping UI state, client cache, and remote data clearly separated.

**AuthContext** holds the active Supabase session and exposes `signIn`, `signUp`, and `signOut` actions. It subscribes to `onAuthStateChange` so the entire app reacts correctly to login and logout events. The session is persisted automatically across page reloads by the Supabase JS client via localStorage.

**LeadsContext** manages everything related to leads using `useReducer`. The reducer holds three distinct kinds of state:

- **Remote data** — the `leads[]` array, fetched once from Supabase on mount and treated as a local cache
- **UI state** — filter, sort, and search string; these are pure client-side values and never trigger server requests
- **Derived state** — `visibleLeads` is computed from the above two, giving the UI a single clean list to render

CRUD actions (`createLead`, `updateLead`, `deleteLead`) call Supabase and then dispatch updates to the reducer immediately, giving the UI an optimistic feel without a refetch.

**Why React Context and useReducer rather than Redux or Zustand?**

The app has two clearly bounded concerns — auth and leads. Context with useReducer covers both without adding third-party dependencies. The reducer keeps all state transitions explicit and testable. A larger app with many feature domains would justify Zustand or Redux Toolkit, but they would add unnecessary complexity here.

**Why keep UI state in the same reducer as remote data?**

It makes `visibleLeads` a single pure derivation with no async coordination. Filtering and sorting are in-memory operations over the cached array, which is the right tradeoff for a list of hundreds of contacts.

---

## BaaS — Supabase

Supabase was chosen as the backend because it provides PostgreSQL, built-in authentication, Row Level Security, and a PostgREST API under a single free-tier project also because its what i am familiar with. For a contact and address store, a relational model with typed columns is a better fit than a document store like Firestore. RLS handles authorization at the database layer, meaning even a malicious client cannot read another user's rows regardless of what queries it sends.

The database schema:

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  name text not null,
  company text,
  email text,
  phone text,
  address text,
  city text,
  country text,
  status text default 'new',
  notes text,
  created_at timestamptz default now()
);

alter table leads enable row level security;

create policy "Users manage own leads" on leads
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

---

## Backend Connection Strategy

The app connects to Supabase using the official `@supabase/supabase-js` client, initialized with the project URL and anon key stored in environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). The anon key is safe to ship client-side because RLS enforces data scoping server-side regardless of what the client sends.

The client automatically attaches the user's JWT to every request, which Supabase uses to evaluate RLS policies. Session tokens are stored in localStorage and refreshed silently by the client library.

All database calls are centralized inside `LeadsContext`. UI components never import or call Supabase directly — they call context actions. This keeps data-fetching logic in one place and makes components easy to test and reuse.

The four operations used:

- `SELECT * FROM leads ORDER BY created_at DESC` — on authenticated mount
- `INSERT INTO leads (...)` — on new lead form submission
- `UPDATE leads SET ... WHERE id = ?` — on lead edit
- `DELETE FROM leads WHERE id = ?` — on lead deletion

---

## Running the Project

```bash
# Install dependencies
npm install @supabase/supabase-js @tanstack/react-router

# Add environment variables
# Create a .env file in the project root:
# VITE_SUPABASE_URL=https://your-project.supabase.co
# VITE_SUPABASE_ANON_KEY=your-anon-key

# Start the dev server
npm run dev
```

---

## File Structure

```
src/
├── App.jsx       — all components, contexts, routes, and app entry
└── main.jsx      — React DOM render root
.env              — Supabase credentials ( committed to Git)
```

---

## AI Tool Usage disclaimer section

AI assistance was used during this project in a limited and specific capacity — for documentation guidance, explaining technical concepts, and providing structural advice on how to organize and write up some of the code in the project. Most code was written, reviewed, and understood by Me independently.
