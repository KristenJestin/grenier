--
-- PostgreSQL database dump
--


-- Dumped from database version 18.0 (Debian 18.0-1.pgdg13+3)
-- Dumped by pg_dump version 18.0 (Debian 18.0-1.pgdg13+3)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: hippocampe_simple; Type: TEXT SEARCH CONFIGURATION; Schema: public; Owner: -
--

CREATE TEXT SEARCH CONFIGURATION public.hippocampe_simple (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR asciiword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR word WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR hword_part WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR hword_asciipart WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR asciihword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR hword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.hippocampe_simple
    ADD MAPPING FOR uint WITH simple;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint,
    name text,
    applied_at timestamp with time zone DEFAULT now()
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: auth_apikey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_apikey (
    id text NOT NULL,
    "configId" text NOT NULL,
    name text,
    start text,
    "referenceId" text NOT NULL,
    prefix text,
    key text NOT NULL,
    "refillInterval" integer,
    "refillAmount" integer,
    "lastRefillAt" timestamp with time zone,
    enabled boolean,
    "rateLimitEnabled" boolean,
    "rateLimitTimeWindow" integer,
    "rateLimitMax" integer,
    "requestCount" integer,
    remaining integer,
    "lastRequest" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    permissions text,
    metadata text
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entries (
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    valid_from date,
    valid_until date,
    superseded_by uuid,
    archived_at timestamp with time zone,
    search_language regconfig DEFAULT 'simple'::regconfig NOT NULL,
    media_text text DEFAULT ''::text NOT NULL,
    search tsvector GENERATED ALWAYS AS (((setweight(to_tsvector(search_language, ((title || ' '::text) || (aliases)::text)), 'A'::"char") || setweight(to_tsvector(search_language, (((tags)::text || ' '::text) || summary)), 'B'::"char")) || setweight(to_tsvector(search_language, ((body || ' '::text) || media_text)), 'C'::"char"))) STORED,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    archived_reason text
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor text NOT NULL,
    entry_id uuid,
    type_name text,
    action text NOT NULL,
    changes jsonb NOT NULL,
    CONSTRAINT events_check CHECK (((entry_id IS NULL) <> (type_name IS NULL)))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: finding_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finding_occurrences (
    id bigint NOT NULL,
    finding integer NOT NULL,
    at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    origin text NOT NULL,
    title text NOT NULL,
    severity text NOT NULL,
    trying text NOT NULL,
    happened text NOT NULL,
    expected text NOT NULL,
    steps text DEFAULT ''::text NOT NULL,
    instance text NOT NULL,
    version text NOT NULL,
    commit text NOT NULL,
    key_name text,
    call_tool text,
    call_arguments text,
    CONSTRAINT finding_occurrences_origin CHECK ((origin = ANY (ARRAY['agent'::text, 'server'::text])))
);


--
-- Name: finding_occurrences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.finding_occurrences ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.finding_occurrences_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.findings (
    number integer NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    place text NOT NULL,
    severity text NOT NULL,
    occurrences integer DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_seen timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    merged_into integer,
    CONSTRAINT findings_kind CHECK ((kind = ANY (ARRAY['bug'::text, 'tool_error'::text, 'unclear_refusal'::text, 'missing_capability'::text, 'wrong_state'::text, 'slow'::text, 'model_friction'::text, 'other'::text]))),
    CONSTRAINT findings_severity CHECK ((severity = ANY (ARRAY['blocks'::text, 'hurts'::text, 'cosmetic'::text])))
);


--
-- Name: findings_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.findings ALTER COLUMN number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.findings_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: heads_up; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.heads_up (
    actor text NOT NULL,
    entry_id uuid NOT NULL,
    field text NOT NULL,
    period text NOT NULL,
    day date NOT NULL
);


--
-- Name: inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    name text,
    content text,
    sha256 text,
    size integer,
    origin text DEFAULT ''::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    taken_by text,
    taken_at timestamp with time zone,
    closed_by text,
    closed_at timestamp with time zone,
    reason text,
    mime text,
    CONSTRAINT inbox_kind CHECK ((kind = ANY (ARRAY['text'::text, 'url'::text, 'file'::text]))),
    CONSTRAINT inbox_status CHECK ((status = ANY (ARRAY['pending'::text, 'taken'::text, 'processed'::text, 'dismissed'::text])))
);


--
-- Name: instance_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_rules (
    id integer DEFAULT 1 NOT NULL,
    rules text NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instance_rules_one CHECK ((id = 1))
);


--
-- Name: links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.links (
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    relation text NOT NULL,
    period text DEFAULT ''::text NOT NULL,
    field text DEFAULT ''::text NOT NULL,
    note text,
    valid_from date,
    valid_until date,
    provenance text,
    seq bigint NOT NULL,
    CONSTRAINT links_provenance CHECK ((((relation = 'mentions'::text) = (provenance IS NULL)) AND ((provenance IS NULL) OR (provenance = ANY (ARRAY['extracted'::text, 'inferred'::text, 'unstated'::text])))))
);


--
-- Name: links_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.links ALTER COLUMN seq ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.links_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media (
    id uuid DEFAULT uuidv7() NOT NULL,
    entry_id uuid NOT NULL,
    kind text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    sha256 text NOT NULL,
    width integer,
    height integer,
    duration double precision,
    source_url text,
    alt text DEFAULT ''::text NOT NULL,
    "position" integer NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pending_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_references (
    source_id uuid NOT NULL,
    slug text NOT NULL
);


--
-- Name: type_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.type_proposals (
    id uuid DEFAULT uuidv7() NOT NULL,
    action text NOT NULL,
    type_name text NOT NULL,
    into_type text,
    mapping jsonb,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by text,
    decided_at timestamp with time zone
);


--
-- Name: types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.types (
    name text NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    fields jsonb NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    sensitive boolean DEFAULT false NOT NULL,
    read_in_parent boolean DEFAULT false NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (1, '2c0b465f5bb7bcda45b66f855e9a2ffe3f6c786a14bd45b948da2dfcc2295ad7', 1791280556000, '20261006095556_baseline', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (2, '59d8afe024b7e48dd0c12f79193b38534b2dd3879abcdebf4ff790f51a9bbc56', 1791281365000, '20261006100925_sensitive_types', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (3, '312d848500f6b68bca743a56bcb6afc62d853f39f3ccceb756753bfd10aaf518', 1791283071000, '20261006103751_entry_sources', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (4, 'ba42598c8515fab8a43835ca7160395e00ab1772637295fbe33103de870f209e', 1791283542000, '20261006104542_inbox', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (5, 'cd049b643c82d5bca9a9e0c52d4cd329b441f97b6c4211cde6a4c56540670689', 1791285374000, '20261006111614_inbox_mime', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (6, '9a48a30f9edb5fc0945a220ec434eac495314d62454ae03ab835a060af9ddae7', 1791288086000, '20261006120126_search_index', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (7, '796570782bc0b5f30dd6a176eaf399ccc12c93f9f8b3c05a5819e079cf274650', 1791302844000, '20261006160724_findings', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (8, '5fa13258be61bf684b05494f6fb9db555f8404f85333544f0165208d90495914', 1791358306000, '20261007073146_instance_rules', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (9, '071a3a0aea8da20aaf20238626e5d71fb740da8cbf7c28f920db68bd6aa906d0', 1791360007000, '20261007080007_read_in_parent', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (10, 'c86ed42f76c1419324c93ab525b5a7274244390d2c5ba924a48c0c655efe6b8c', 1791362896000, '20261007084816_pending_references', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (11, '6046770ce8dd09f6abe4ddb0199405067921e9a1910f126af0a793ac866574e5', 1791363515000, '20261007085835_merged_findings', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (12, '1b7e21af29379cc50b1967b6bf6dd02745344de06f1b09b90151f16a0dbbd78f', 1791370775000, '20261007105935_merged_into_key', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (13, '47a02fe4346d1f5110037e3b20fb4f1be5163ac71af5e1e14e9f4c5658c2791e', 1791371633000, '20261007111353_remove_source_registry', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (14, 'a1898393371b786315f511e641fc6bda5ff6807cc5fe28d662926ae326492ca9', 1791374251000, '20261007115731_link_note_and_dates', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (15, 'c499b165920331192c1d0a215f1b647ba70734061e7ff72671e336389463f347', 1791446385000, '20261008075945_resolve_stale_pending', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (16, '01b9f06886f4035ca397760af4e845825361e12fdab5f9465614835b59161fd8', 1791447143000, '20261008081223_archived_reason', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (17, '3657eaa61b360fc6f79309ba57973f39403265686266116a88641d0804614e8d', 1791561641000, '20261009160041_entries_aliases', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (18, '429565618d20d25d3022ed43a1a3a32f58ca35170dbe389f2618944a28fb37c1', 1791570551000, '20261009182911_known_or_supposed', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (19, 'c79de8b82e34eb6c35b8031ab4c9b8034886e1021dd75a4b9b3abf1b02d9cfc8', 1791575260000, '20261009194740_part_of', '2026-10-10 14:31:14.115259+00');
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name, applied_at) VALUES (20, '73e5ff931cc1f2c58d0eb9fcd1baadc6303121d59fe58bc5634901beee968083', 1791579824000, '20261009210344_rename_to_hippocampe', '2026-10-10 14:31:14.115259+00');


--
-- Data for Name: auth_account; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_apikey; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.auth_apikey (id, "configId", name, start, "referenceId", prefix, key, "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata) VALUES ('fF6k1uMKnsPnVBTN7RevNJNenccTlQ3e', 'default', 'agent-kitchen', 'hippoc', 'Ko5sv3yuaFOyQoaymf7GMz8jXTGIwLXO', 'hippocampe_', 'A-OMkQHImqQ__dHT7b4z4ecFv-rAWJXr_N1gBGtMos8', NULL, NULL, NULL, true, false, 86400000, 10, 0, NULL, NULL, NULL, '2026-10-10 14:31:14.221+00', '2026-10-10 14:31:14.221+00', '{"hippocampe":["read","write","sensitive"]}', '{}');
INSERT INTO public.auth_apikey (id, "configId", name, start, "referenceId", prefix, key, "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata) VALUES ('ZrhfiVluSlfjG6KRv8PzRVSYxCGlB5Fp', 'default', 'agent-garden', 'hippoc', 'Ko5sv3yuaFOyQoaymf7GMz8jXTGIwLXO', 'hippocampe_', 'sz9yislFjer-Rpw3by5LSBUumNxehEtDk93r6QHJjvw', NULL, NULL, NULL, true, false, 86400000, 10, 0, NULL, NULL, NULL, '2026-10-10 14:31:14.708+00', '2026-10-10 14:31:14.708+00', '{"hippocampe":["read","write"]}', '{}');
INSERT INTO public.auth_apikey (id, "configId", name, start, "referenceId", prefix, key, "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata) VALUES ('hCsPw0yOC0Ty9FKyaHzbgfbOmBYSBGpo', 'default', 'reader', 'hippoc', 'Ko5sv3yuaFOyQoaymf7GMz8jXTGIwLXO', 'hippocampe_', 'mnajUPzh3GA5LHk-cAfTeF2qoSO3WY484wG_SRHP_YA', NULL, NULL, NULL, true, false, 86400000, 10, 0, NULL, NULL, NULL, '2026-10-10 14:31:15.203+00', '2026-10-10 14:31:15.203+00', '{"hippocampe":["read"]}', '{"expires_at":"2036-10-07T14:31:15.196Z"}');
INSERT INTO public.auth_apikey (id, "configId", name, start, "referenceId", prefix, key, "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled", "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata) VALUES ('Gc45OwY6FzIwxGT57mx1wiouIVuXqHQ0', 'default', 'old-laptop', 'hippoc', 'Ko5sv3yuaFOyQoaymf7GMz8jXTGIwLXO', 'hippocampe_', 'zI3LzwzUVmeYGYMTTJYrcEoR7-MB9Un2L_8Zj0XZfoQ', NULL, NULL, NULL, false, false, 86400000, 10, 0, NULL, NULL, NULL, '2026-10-10 14:31:15.723+00', '2026-10-10 14:31:15.723+00', '{"hippocampe":["read","write"]}', '{}');


--
-- Data for Name: auth_session; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: auth_user; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.auth_user (id, name, email, "emailVerified", image, "createdAt", "updatedAt") VALUES ('Ko5sv3yuaFOyQoaymf7GMz8jXTGIwLXO', 'Owner', 'owner@example.org', true, NULL, '2026-10-10 14:31:14.2+00', '2026-10-10 14:31:14.2+00');


--
-- Data for Name: auth_verification; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b00c-7a09-aebf-95d0f35d66e2', 'person', 'Morgan Vale', 'morgan-vale', '[]', '[]', '{}', '{"summary": "inferred"}', '', 'The owner of this Hippocampe.', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b015-7e75-a3ff-a912f5c9cf68', 'organization', 'Northwind Hardware', 'northwind-hardware', '[]', '["shop"]', '{"city": "Port Alder", "website": "https://northwind.example"}', '{"city": "extracted", "website": "extracted"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"url": "https://northwind.example/contact", "note": "the contact page"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b01b-716a-b234-871f619160b1', 'organization', 'Bluebell Energy', 'bluebell-energy', '[]', '[]', '{"website": "https://bluebell.example"}', '{"website": "inferred"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b01f-7999-8e9f-3c04dd2d829a', 'organization', 'Lakeside Library', 'lakeside-library', '[]', '[]', '{"city": "Port Alder"}', '{"city": "ambiguous"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b031-7215-84ac-52d237c6cacc', 'note', 'Garden shed', 'garden-shed', '[]', '[]', '{}', '{"body": "extracted"}', 'The wooden shed at the end of the garden.', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"on": "2026-09-02", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b035-724a-9b8f-69ab6e6dc44d', 'note', 'Garage', 'garage', '[]', '[]', '{}', '{"body": "inferred"}', 'Beside the house.', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b03f-70db-a094-f673ef16594b', 'item', 'Workshop computer disk', 'workshop-computer-disk', '[]', '[]', '{"brand": "Petrel", "serial": "PT-77-0031"}', '{"brand": "extracted", "serial": "extracted"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"note": "listed on its invoice", "entry": "01a12639-b03a-7461-a501-e5a6c78c4831"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b055-763a-9533-199ba4ccf6b3', 'journal', 'Journal, 30 September', 'journal-2026-09-30', '[]', '[]', '{"mood": "calm"}', '{"body": "extracted", "mood": "extracted"}', 'A quiet day in the garden; the mower is getting old.', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.231328+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"on": "2026-09-30", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b05c-7d24-b73a-f7d2f190bb94', 'note', 'Garden plan 2025', 'garden-plan-2025', '[]', '[]', '{}', '{"body": "extracted"}', 'Tomatoes along the fence.', '', '2025-02-01 00:00:00+00', '2026-10-10 14:31:17.494958+00', NULL, NULL, '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'public.hippocampe_simple', '', '[{"on": "2025-02-01", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b025-79c5-b6dc-28656f16ce89', 'person', 'Alma Quillon', 'alma-quillon', '["Alma Q."]', '[]', '{"email": "alma@example.org", "birthday": "1990-04-21", "employer": "01a12639-b015-7e75-a3ff-a912f5c9cf68", "languages": ["English", "Portuguese"]}', '{"body": "extracted", "email": "extracted", "birthday": "extracted", "employer": "extracted", "languages": "inferred"}', 'Met at [[northwind-hardware]]. Lends tools.', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.512876+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"on": "2026-09-01", "note": "at the hardware shop", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b048-7aeb-b282-71ded986e13d', 'item', 'Bike pump', 'bike-pump', '[]', '[]', '{"brand": "Swiftair"}', '{"brand": "inferred"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.529957+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b04c-7f2d-a39d-650bb642288a', 'item', 'Old radio', 'old-radio', '[]', '[]', '{"brand": "Halcyon"}', '{"brand": "inferred"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.548542+00', NULL, NULL, NULL, '2026-10-10 14:31:17.548542+00', 'public.hippocampe_simple', '', '[]', 'given to a neighbour');
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b060-7aa1-949b-7adeeb9f3dda', 'note', 'Garden plans', 'garden-plan', '["Vegetable plan"]', '["garden"]', '{}', '{"body": "inferred", "summary": "inferred"}', 'Started on 1 March.

Beans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]].', 'What grows where this year.', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.472998+00', '2026-03-01', '2026-11-30', NULL, NULL, 'public.hippocampe_simple', 'Sketch of the beds', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b051-7511-b2f5-a1a4748e8e02', 'contract', 'Home electricity', 'home-electricity', '[]', '[]', '{"renewal": "2025-11-01", "provider": "01a12639-b01b-716a-b234-871f619160b1", "signed_at": "2024-10-15T09:30:00Z", "monthly_cost": "64.20 EUR", "notice_period": "P1M", "account_number": "ACC-5521"}', '{"renewal": "extracted", "provider": "extracted", "signed_at": "extracted", "monthly_cost": "extracted", "notice_period": "extracted", "account_number": "extracted"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.862816+00', '2024-11-01', NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"url": "https://bluebell.example/account", "note": "the customer account"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b058-7e97-ac3b-556395197564', 'item', 'Pocket torch', 'pocket-torch', '[]', '[]', '{"brand": "Lumen"}', '{"brand": "inferred"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:19.268258+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b02c-7650-bd6c-d9a11080e5f0', 'person', 'Bruno Tessaly', 'bruno-tessaly', '[]', '[]', '{"employer": "01a12639-b01b-716a-b234-871f619160b1"}', '{"employer": "extracted"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:20.19654+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"on": "2026-10-10", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b043-7d5f-a8de-cc231ebc5208', 'item', 'Lawn mower', 'lawn-mower', '[]', '[]', '{"brand": "Greenfinch", "portable": true, "condition": "worn"}', '{"brand": "inferred", "portable": "inferred", "condition": "inferred"}', '', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:21.17813+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', 'Receipt of the mower', '[{"item": "01a12639-bd5e-7e4a-b460-714997fb09d1", "source": "inbox"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b1be-7292-9be9-62c16c184ab6', 'note', 'Electricity renewal 2025', 'electricity-renewal-2025', '[]', '[]', '{}', '{"body": "extracted"}', 'Renewed for a year.', '', '2026-10-10 14:31:17.692447+00', '2026-10-10 14:31:17.692447+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"on": "2025-10-20", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-b03a-7461-a501-e5a6c78c4831', 'item', 'Workshop computer', 'workshop-computer', '[]', '["workshop", "computer"]', '{"brand": "Corvid", "price": "849.00 EUR", "serial": "CV-1029-XA", "power_w": 350, "sellers": ["01a12639-b015-7e75-a3ff-a912f5c9cf68", "01a12639-b01f-7999-8e9f-3c04dd2d829a"], "portable": false, "bought_on": "2024-02-14", "condition": "worn", "weight_kg": 7.5, "warranty_until": "2027-02-14"}', '{"body": "inferred", "brand": "extracted", "price": "extracted", "serial": "extracted", "power_w": "extracted", "sellers": "inferred", "portable": "inferred", "bought_on": "ambiguous", "condition": "inferred", "weight_kg": "inferred", "warranty_until": "extracted"}', 'Under the left workbench. Probably needs a new fan.The fan was replaced in October.', '', '2026-10-10 14:31:17.231328+00', '2026-10-10 14:31:17.804323+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', 'Front of the case, with the new fan', '[{"note": "the invoice", "label": "invoice", "identifier": "INV-0042"}]', NULL);
INSERT INTO public.entries (id, type, title, slug, aliases, tags, fields, provenance, body, summary, created, updated, valid_from, valid_until, superseded_by, archived_at, search_language, media_text, sources, archived_reason) VALUES ('01a12639-bfde-7a38-bff9-edea7848d7a5', 'note', 'Shed door', 'shed-door', '[]', '[]', '{}', '{"body": "extracted"}', 'The hinges need oil.', '', '2026-10-10 14:31:21.304049+00', '2026-10-10 14:31:21.304049+00', NULL, NULL, NULL, NULL, 'public.hippocampe_simple', '', '[{"item": "01a12639-bd73-748f-a980-0c82ecc844ee", "source": "inbox"}]', NULL);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (1, '2026-10-10 14:31:17.093455+00', 'agent-kitchen', NULL, 'organization', 'define', '[{"after": "Organization", "field": "label", "before": null}, {"after": "A company, a shop or a library people deal with.", "field": "description", "before": null}, {"after": {"kind": "url", "name": "website"}, "field": "fields.website", "before": null}, {"after": {"kind": "text", "name": "city"}, "field": "fields.city", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (2, '2026-10-10 14:31:17.126832+00', 'agent-kitchen', NULL, 'person', 'define', '[{"after": "Person", "field": "label", "before": null}, {"after": "Someone the owner knows.", "field": "description", "before": null}, {"after": {"kind": "text", "name": "email", "sensitive": true}, "field": "fields.email", "before": null}, {"after": {"kind": "date", "name": "birthday", "recurs": {"every": "yearly", "notice": "P14D"}}, "field": "fields.birthday", "before": null}, {"after": {"kind": "entry", "name": "employer", "types": ["organization"]}, "field": "fields.employer", "before": null}, {"after": {"kind": "text", "many": true, "name": "languages"}, "field": "fields.languages", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (3, '2026-10-10 14:31:17.142863+00', 'agent-kitchen', NULL, 'item', 'define', '[{"after": "Item", "field": "label", "before": null}, {"after": "A thing the owner keeps: a tool, a machine, a piece of furniture.", "field": "description", "before": null}, {"after": true, "field": "read_in_parent", "before": null}, {"after": {"kind": "text", "name": "brand", "required": true}, "field": "fields.brand", "before": null}, {"after": {"kind": "text", "name": "serial", "sensitive": true}, "field": "fields.serial", "before": null}, {"after": {"kind": "money", "name": "price"}, "field": "fields.price", "before": null}, {"after": {"kind": "date", "name": "bought_on"}, "field": "fields.bought_on", "before": null}, {"after": {"due": {"notice": "P30D"}, "kind": "date", "name": "warranty_until"}, "field": "fields.warranty_until", "before": null}, {"after": {"kind": "entry", "many": true, "name": "sellers", "types": ["organization"]}, "field": "fields.sellers", "before": null}, {"after": {"kind": "integer", "name": "power_watts"}, "field": "fields.power_watts", "before": null}, {"after": {"kind": "number", "name": "weight_kg"}, "field": "fields.weight_kg", "before": null}, {"after": {"kind": "boolean", "name": "portable"}, "field": "fields.portable", "before": null}, {"after": {"kind": "enum", "name": "condition", "values": ["new", "used", "worn"]}, "field": "fields.condition", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (4, '2026-10-10 14:31:17.160256+00', 'agent-kitchen', NULL, 'contract', 'define', '[{"after": "Contract", "field": "label", "before": null}, {"after": "A contract or a subscription followed over time.", "field": "description", "before": null}, {"after": {"kind": "entry", "name": "provider", "types": ["organization"]}, "field": "fields.provider", "before": null}, {"after": {"kind": "money", "name": "monthly_cost"}, "field": "fields.monthly_cost", "before": null}, {"after": {"kind": "date", "name": "renewal", "recurs": {"every": "yearly", "notice": "P30D"}}, "field": "fields.renewal", "before": null}, {"after": {"kind": "duration", "name": "notice_period"}, "field": "fields.notice_period", "before": null}, {"after": {"kind": "datetime", "name": "signed_at"}, "field": "fields.signed_at", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (5, '2026-10-10 14:31:17.176147+00', 'agent-kitchen', NULL, 'journal', 'define', '[{"after": "Journal", "field": "label", "before": null}, {"after": "A page of the private journal.", "field": "description", "before": null}, {"after": true, "field": "sensitive", "before": null}, {"after": {"kind": "enum", "name": "mood", "values": ["calm", "busy", "tired"]}, "field": "fields.mood", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (6, '2026-10-10 14:31:17.189998+00', 'agent-kitchen', NULL, 'note', 'define', '[{"after": "Note", "field": "label", "before": null}, {"after": "A free note, or a place things are kept in.", "field": "description", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (7, '2026-10-10 14:31:17.20423+00', 'agent-kitchen', NULL, 'gadget', 'define', '[{"after": "Gadget", "field": "label", "before": null}, {"after": "A small device; to be merged into items.", "field": "description", "before": null}, {"after": {"kind": "text", "name": "brand"}, "field": "fields.brand", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (8, '2026-10-10 14:31:17.21754+00', 'agent-kitchen', NULL, 'draft', 'define', '[{"after": "Draft", "field": "label", "before": null}, {"after": "A type no entry uses.", "field": "description", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (9, '2026-10-10 14:31:17.262261+00', 'agent-kitchen', '01a12639-b00c-7a09-aebf-95d0f35d66e2', NULL, 'create', '[{"after": "person", "field": "type", "before": null}, {"after": "Morgan Vale", "field": "title", "before": null}, {"after": "morgan-vale", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "The owner of this Hippocampe.", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "inferred", "field": "provenance.summary", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (10, '2026-10-10 14:31:17.270465+00', 'agent-kitchen', '01a12639-b015-7e75-a3ff-a912f5c9cf68', NULL, 'create', '[{"after": "organization", "field": "type", "before": null}, {"after": "Northwind Hardware", "field": "title", "before": null}, {"after": "northwind-hardware", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": ["shop"], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"url": "https://northwind.example/contact", "note": "the contact page"}], "field": "sources", "before": null}, {"after": "https://northwind.example", "field": "fields.website", "before": null}, {"after": "Port Alder", "field": "fields.city", "before": null}, {"after": "extracted", "field": "provenance.website", "before": null}, {"after": "extracted", "field": "provenance.city", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (11, '2026-10-10 14:31:17.275552+00', 'agent-kitchen', '01a12639-b01b-716a-b234-871f619160b1', NULL, 'create', '[{"after": "organization", "field": "type", "before": null}, {"after": "Bluebell Energy", "field": "title", "before": null}, {"after": "bluebell-energy", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "https://bluebell.example", "field": "fields.website", "before": null}, {"after": "inferred", "field": "provenance.website", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (12, '2026-10-10 14:31:17.280129+00', 'agent-kitchen', '01a12639-b01f-7999-8e9f-3c04dd2d829a', NULL, 'create', '[{"after": "organization", "field": "type", "before": null}, {"after": "Lakeside Library", "field": "title", "before": null}, {"after": "lakeside-library", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "Port Alder", "field": "fields.city", "before": null}, {"after": "ambiguous", "field": "provenance.city", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (13, '2026-10-10 14:31:17.286141+00', 'agent-kitchen', '01a12639-b025-79c5-b6dc-28656f16ce89', NULL, 'create', '[{"after": "person", "field": "type", "before": null}, {"after": "Alma Quillon", "field": "title", "before": null}, {"after": "alma-quillon", "field": "slug", "before": null}, {"after": ["Alma Q."], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "Met at [[northwind-hardware]]. Lends tools.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"on": "2026-09-01", "note": "at the hardware shop", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": null}, {"after": "alma@example.org", "field": "fields.email", "before": null}, {"after": "1990-04-12", "field": "fields.birthday", "before": null}, {"after": "01a12639-b015-7e75-a3ff-a912f5c9cf68", "field": "fields.employer", "before": null}, {"after": ["English", "Portuguese"], "field": "fields.languages", "before": null}, {"after": "extracted", "field": "provenance.email", "before": null}, {"after": "extracted", "field": "provenance.birthday", "before": null}, {"after": "extracted", "field": "provenance.employer", "before": null}, {"after": "inferred", "field": "provenance.languages", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (14, '2026-10-10 14:31:17.292888+00', 'agent-kitchen', '01a12639-b02c-7650-bd6c-d9a11080e5f0', NULL, 'create', '[{"after": "person", "field": "type", "before": null}, {"after": "Bruno Tessaly", "field": "title", "before": null}, {"after": "bruno-tessaly", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "01a12639-b01b-716a-b234-871f619160b1", "field": "fields.employer", "before": null}, {"after": "inferred", "field": "provenance.employer", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (15, '2026-10-10 14:31:17.297535+00', 'agent-kitchen', '01a12639-b031-7215-84ac-52d237c6cacc', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Garden shed", "field": "title", "before": null}, {"after": "garden-shed", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "The wooden shed at the end of the garden.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"on": "2026-09-02", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (16, '2026-10-10 14:31:17.301604+00', 'agent-kitchen', '01a12639-b035-724a-9b8f-69ab6e6dc44d', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Garage", "field": "title", "before": null}, {"after": "garage", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "Beside the house.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "inferred", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (17, '2026-10-10 14:31:17.30679+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'create', '[{"after": "item", "field": "type", "before": null}, {"after": "Workshop computer", "field": "title", "before": null}, {"after": "workshop-computer", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": ["workshop", "computer"], "field": "tags", "before": null}, {"after": "Under the workbench. Probably needs a new fan.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"note": "the invoice", "label": "invoice", "identifier": "INV-0042"}], "field": "sources", "before": null}, {"after": "Corvid", "field": "fields.brand", "before": null}, {"after": "CV-1029-XA", "field": "fields.serial", "before": null}, {"after": "899.00 EUR", "field": "fields.price", "before": null}, {"after": "2024-02-14", "field": "fields.bought_on", "before": null}, {"after": "2027-02-14", "field": "fields.warranty_until", "before": null}, {"after": ["01a12639-b015-7e75-a3ff-a912f5c9cf68", "01a12639-b01f-7999-8e9f-3c04dd2d829a"], "field": "fields.sellers", "before": null}, {"after": 350, "field": "fields.power_watts", "before": null}, {"after": 7.5, "field": "fields.weight_kg", "before": null}, {"after": false, "field": "fields.portable", "before": null}, {"after": "used", "field": "fields.condition", "before": null}, {"after": "extracted", "field": "provenance.brand", "before": null}, {"after": "extracted", "field": "provenance.serial", "before": null}, {"after": "extracted", "field": "provenance.price", "before": null}, {"after": "ambiguous", "field": "provenance.bought_on", "before": null}, {"after": "extracted", "field": "provenance.warranty_until", "before": null}, {"after": "inferred", "field": "provenance.sellers", "before": null}, {"after": "extracted", "field": "provenance.power_watts", "before": null}, {"after": "inferred", "field": "provenance.weight_kg", "before": null}, {"after": "inferred", "field": "provenance.portable", "before": null}, {"after": "inferred", "field": "provenance.condition", "before": null}, {"after": "inferred", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (18, '2026-10-10 14:31:17.311835+00', 'agent-kitchen', '01a12639-b03f-70db-a094-f673ef16594b', NULL, 'create', '[{"after": "item", "field": "type", "before": null}, {"after": "Workshop computer disk", "field": "title", "before": null}, {"after": "workshop-computer-disk", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"note": "listed on its invoice", "entry": "01a12639-b03a-7461-a501-e5a6c78c4831"}], "field": "sources", "before": null}, {"after": "Petrel", "field": "fields.brand", "before": null}, {"after": "PT-77-0031", "field": "fields.serial", "before": null}, {"after": "extracted", "field": "provenance.brand", "before": null}, {"after": "extracted", "field": "provenance.serial", "before": null}, {"after": {"entry": "01a12639-b03a-7461-a501-e5a6c78c4831", "provenance": "extracted"}, "field": "links.part_of", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (19, '2026-10-10 14:31:17.31664+00', 'agent-kitchen', '01a12639-b043-7d5f-a8de-cc231ebc5208', NULL, 'create', '[{"after": "item", "field": "type", "before": null}, {"after": "Lawn mower", "field": "title", "before": null}, {"after": "lawn-mower", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "Greenfinch", "field": "fields.brand", "before": null}, {"after": "worn", "field": "fields.condition", "before": null}, {"after": true, "field": "fields.portable", "before": null}, {"after": "inferred", "field": "provenance.brand", "before": null}, {"after": "inferred", "field": "provenance.condition", "before": null}, {"after": "inferred", "field": "provenance.portable", "before": null}, {"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred"}, "field": "links.part_of", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (20, '2026-10-10 14:31:17.321401+00', 'agent-kitchen', '01a12639-b048-7aeb-b282-71ded986e13d', NULL, 'create', '[{"after": "item", "field": "type", "before": null}, {"after": "Bike pump", "field": "title", "before": null}, {"after": "bike-pump", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "Swiftair", "field": "fields.brand", "before": null}, {"after": "inferred", "field": "provenance.brand", "before": null}, {"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred"}, "field": "links.part_of", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (36, '2026-10-10 14:31:17.565617+00', 'agent-kitchen', '01a12639-b025-79c5-b6dc-28656f16ce89', NULL, 'link', '[{"after": {"note": "cashier", "entry": "01a12639-b015-7e75-a3ff-a912f5c9cf68", "provenance": "extracted", "valid_from": "2019-03-01", "valid_until": "2021-08-31"}, "field": "links.works_at", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (21, '2026-10-10 14:31:17.325331+00', 'agent-kitchen', '01a12639-b04c-7f2d-a39d-650bb642288a', NULL, 'create', '[{"after": "item", "field": "type", "before": null}, {"after": "Old radio", "field": "title", "before": null}, {"after": "old-radio", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "Halcyon", "field": "fields.brand", "before": null}, {"after": "inferred", "field": "provenance.brand", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (22, '2026-10-10 14:31:17.329713+00', 'agent-kitchen', '01a12639-b051-7511-b2f5-a1a4748e8e02', NULL, 'create', '[{"after": "contract", "field": "type", "before": null}, {"after": "Home electricity", "field": "title", "before": null}, {"after": "home-electricity", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": "2024-11-01", "field": "valid_from", "before": null}, {"after": [{"url": "https://bluebell.example/account", "note": "the customer account"}], "field": "sources", "before": null}, {"after": "01a12639-b01b-716a-b234-871f619160b1", "field": "fields.provider", "before": null}, {"after": "64.20 EUR", "field": "fields.monthly_cost", "before": null}, {"after": "2025-11-01", "field": "fields.renewal", "before": null}, {"after": "P1M", "field": "fields.notice_period", "before": null}, {"after": "2024-10-15T09:30:00Z", "field": "fields.signed_at", "before": null}, {"after": "extracted", "field": "provenance.provider", "before": null}, {"after": "extracted", "field": "provenance.monthly_cost", "before": null}, {"after": "extracted", "field": "provenance.renewal", "before": null}, {"after": "extracted", "field": "provenance.notice_period", "before": null}, {"after": "extracted", "field": "provenance.signed_at", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (23, '2026-10-10 14:31:17.333768+00', 'agent-kitchen', '01a12639-b055-763a-9533-199ba4ccf6b3', NULL, 'create', '[{"after": "journal", "field": "type", "before": null}, {"after": "Journal, 30 September", "field": "title", "before": null}, {"after": "journal-2026-09-30", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "A quiet day in the garden; the mower is getting old.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"on": "2026-09-30", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": null}, {"after": "calm", "field": "fields.mood", "before": null}, {"after": "extracted", "field": "provenance.mood", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (24, '2026-10-10 14:31:17.337296+00', 'agent-kitchen', '01a12639-b058-7e97-ac3b-556395197564', NULL, 'create', '[{"after": "gadget", "field": "type", "before": null}, {"after": "Pocket torch", "field": "title", "before": null}, {"after": "pocket-torch", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "Lumen", "field": "fields.brand", "before": null}, {"after": "inferred", "field": "provenance.brand", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (25, '2026-10-10 14:31:17.341189+00', 'agent-kitchen', '01a12639-b05c-7d24-b73a-f7d2f190bb94', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Garden plan 2025", "field": "title", "before": null}, {"after": "garden-plan-2025", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "Tomatoes along the fence.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"on": "2025-02-01", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (26, '2026-10-10 14:31:17.345212+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Garden plans", "field": "title", "before": null}, {"after": "garden-plans", "field": "slug", "before": null}, {"after": ["Vegetable plan"], "field": "aliases", "before": null}, {"after": ["garden"], "field": "tags", "before": null}, {"after": "Beans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]].", "field": "body", "before": null}, {"after": "What grows where this year.", "field": "summary", "before": null}, {"after": "2026-03-01", "field": "valid_from", "before": null}, {"after": "2026-11-30", "field": "valid_until", "before": null}, {"after": [], "field": "sources", "before": null}, {"after": "inferred", "field": "provenance.body", "before": null}, {"after": "inferred", "field": "provenance.summary", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (27, '2026-10-10 14:31:17.389242+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'update', '[{"after": "849.00 EUR", "field": "fields.price", "before": "899.00 EUR"}, {"after": "worn", "field": "fields.condition", "before": "used"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (28, '2026-10-10 14:31:17.4081+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'update', '[{"after": "Under the workbench. Probably needs a new fan.The fan was replaced in October.", "field": "body", "before": "Under the workbench. Probably needs a new fan."}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (29, '2026-10-10 14:31:17.43101+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'update', '[{"after": "Under the left workbench. Probably needs a new fan.The fan was replaced in October.", "field": "body", "before": "Under the workbench. Probably needs a new fan.The fan was replaced in October."}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (30, '2026-10-10 14:31:17.455433+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'update', '[{"after": "garden-plan", "field": "slug", "before": "garden-plans"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (31, '2026-10-10 14:31:17.478554+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'update', '[{"after": "Started on 1 March.\n\nBeans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]].", "field": "body", "before": "Beans by the [[garden-shed]], an [[herb-spiral]] by the path; mow with the [[lawn-mower]]."}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (32, '2026-10-10 14:31:17.498306+00', 'agent-kitchen', '01a12639-b05c-7d24-b73a-f7d2f190bb94', NULL, 'update', '[{"after": "01a12639-b060-7aa1-949b-7adeeb9f3dda", "field": "superseded_by", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (33, '2026-10-10 14:31:17.515974+00', 'agent-kitchen', '01a12639-b025-79c5-b6dc-28656f16ce89', NULL, 'update', '[{"after": "1990-04-21", "field": "fields.birthday", "before": "1990-04-12"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (34, '2026-10-10 14:31:17.534727+00', 'agent-kitchen', '01a12639-b048-7aeb-b282-71ded986e13d', NULL, 'update', '[{"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred", "valid_until": "2026-10-09"}, "field": "links.part_of", "before": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred"}}, {"after": {"entry": "01a12639-b035-724a-9b8f-69ab6e6dc44d", "provenance": "inferred", "valid_from": "2026-10-10"}, "field": "links.part_of", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (35, '2026-10-10 14:31:17.550206+00', 'agent-kitchen', '01a12639-b04c-7f2d-a39d-650bb642288a', NULL, 'archive', '[{"after": "2026-10-10T14:31:17.548Z", "field": "archived_at", "before": null}, {"after": "given to a neighbour", "field": "archived_reason", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (37, '2026-10-10 14:31:17.578812+00', 'agent-kitchen', '01a12639-b02c-7650-bd6c-d9a11080e5f0', NULL, 'link', '[{"after": {"note": "meter reader", "entry": "01a12639-b01b-716a-b234-871f619160b1", "provenance": "inferred", "valid_from": "2022-05-01"}, "field": "links.works_at", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (38, '2026-10-10 14:31:17.59191+00', 'agent-kitchen', '01a12639-b025-79c5-b6dc-28656f16ce89', NULL, 'link', '[{"after": {"entry": "01a12639-b02c-7650-bd6c-d9a11080e5f0", "provenance": "inferred"}, "field": "links.knows", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (39, '2026-10-10 14:31:17.61117+00', 'agent-kitchen', '01a12639-b043-7d5f-a8de-cc231ebc5208', NULL, 'link', '[{"after": {"note": "spring sale", "entry": "01a12639-b015-7e75-a3ff-a912f5c9cf68", "provenance": "inferred"}, "field": "links.bought_from", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (40, '2026-10-10 14:31:17.627611+00', 'agent-kitchen', '01a12639-b04c-7f2d-a39d-650bb642288a', NULL, 'link', '[{"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred", "valid_from": "2018-01-01", "valid_until": "2020-12-31"}, "field": "links.part_of", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (41, '2026-10-10 14:31:17.645439+00', 'agent-kitchen', '01a12639-b04c-7f2d-a39d-650bb642288a', NULL, 'link', '[{"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "inferred", "valid_from": "2023-01-01", "valid_until": "2024-06-30"}, "field": "links.part_of.2023-01-01", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (42, '2026-10-10 14:31:17.661949+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'link', '[{"after": {"entry": "01a12639-b03a-7461-a501-e5a6c78c4831", "provenance": "inferred"}, "field": "links.about", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (43, '2026-10-10 14:31:17.679941+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'unlink', '[{"after": null, "field": "links.about", "before": {"entry": "01a12639-b03a-7461-a501-e5a6c78c4831", "provenance": "inferred"}}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (44, '2026-10-10 14:31:17.694516+00', 'agent-kitchen', '01a12639-b1be-7292-9be9-62c16c184ab6', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Electricity renewal 2025", "field": "title", "before": null}, {"after": "electricity-renewal-2025", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "Renewed for a year.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"on": "2025-10-20", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (45, '2026-10-10 14:31:17.714198+00', 'agent-kitchen', '01a12639-b1be-7292-9be9-62c16c184ab6', NULL, 'link', '[{"after": {"entry": "01a12639-b051-7511-b2f5-a1a4748e8e02", "provenance": "extracted"}, "field": "links.fulfills.renewal.2025", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (46, '2026-10-10 14:31:17.735224+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'attach', '[{"after": {"mime": "image/png", "size": 68, "sha256": "63ef318d96b5d0d0ceba6e04a4e622b1158335cdc67c49e27839132c6f655058"}, "field": "media.01a12639-b1e5-7ddb-a161-06838ee06fda", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (47, '2026-10-10 14:31:17.749459+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'update', '[{"after": "Front of the case, with the new fan", "field": "media.01a12639-b1e5-7ddb-a161-06838ee06fda.alt", "before": "Front of the case"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (48, '2026-10-10 14:31:17.763621+00', 'agent-kitchen', '01a12639-b060-7aa1-949b-7adeeb9f3dda', NULL, 'attach', '[{"after": {"mime": "image/svg+xml", "size": 111, "sha256": "a0b033249dfac33872fd0ee79092a054b856076d1d990dc936c6b807a1fe763b"}, "field": "media.01a12639-b202-7d3a-9295-ff5b176549f6", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (49, '2026-10-10 14:31:17.777788+00', 'agent-kitchen', NULL, 'organization', 'change_type', '[{"after": "A company, a shop, a library or any body the owner deals with.", "field": "description", "before": "A company, a shop or a library people deal with."}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (50, '2026-10-10 14:31:17.792085+00', 'agent-kitchen', NULL, 'person', 'add_field', '[{"after": {"kind": "text", "name": "nickname"}, "field": "fields.nickname", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (51, '2026-10-10 14:31:17.808496+00', 'agent-kitchen', NULL, 'item', 'change_field', '[{"after": null, "field": "fields.power_watts", "before": {"kind": "integer", "name": "power_watts"}}, {"after": {"kind": "integer", "name": "power_w"}, "field": "fields.power_w", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (52, '2026-10-10 14:31:17.809416+00', 'agent-kitchen', '01a12639-b03a-7461-a501-e5a6c78c4831', NULL, 'update', '[{"after": null, "field": "fields.power_watts", "before": 350}, {"after": null, "field": "provenance.power_watts", "before": "extracted"}, {"after": 350, "field": "fields.power_w", "before": null}, {"after": "extracted", "field": "provenance.power_w", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (53, '2026-10-10 14:31:17.822957+00', 'agent-kitchen', NULL, 'item', 'change_field', '[{"after": {"kind": "enum", "name": "condition", "values": ["new", "used", "worn", "broken"]}, "field": "fields.condition", "before": {"kind": "enum", "name": "condition", "values": ["new", "used", "worn"]}}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (54, '2026-10-10 14:31:17.836614+00', 'agent-kitchen', NULL, 'contract', 'change_field', '[{"after": {"kind": "entry", "name": "provider", "types": ["organization"], "required": true}, "field": "fields.provider", "before": {"kind": "entry", "name": "provider", "types": ["organization"]}}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (55, '2026-10-10 14:31:17.850827+00', 'agent-kitchen', NULL, 'contract', 'add_field', '[{"after": {"kind": "text", "name": "account_number", "sensitive": true}, "field": "fields.account_number", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (56, '2026-10-10 14:31:17.865193+00', 'agent-kitchen', '01a12639-b051-7511-b2f5-a1a4748e8e02', NULL, 'update', '[{"after": "ACC-5521", "field": "fields.account_number", "before": null}, {"after": "extracted", "field": "provenance.account_number", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (57, '2026-10-10 14:31:18.309568+00', 'owner', NULL, 'contract', 'change_field', '[{"after": {"kind": "text", "name": "account_number"}, "field": "fields.account_number", "before": {"kind": "text", "name": "account_number", "sensitive": true}}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (58, '2026-10-10 14:31:18.332948+00', 'agent-kitchen', NULL, 'note', 'change_type', '[{"after": true, "field": "sensitive", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (59, '2026-10-10 14:31:18.773969+00', 'owner', NULL, 'note', 'change_type', '[{"after": null, "field": "sensitive", "before": true}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (60, '2026-10-10 14:31:19.286474+00', 'owner', '01a12639-b058-7e97-ac3b-556395197564', NULL, 'update', '[{"after": "item", "field": "type", "before": "gadget"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (61, '2026-10-10 14:31:19.287945+00', 'owner', NULL, 'gadget', 'merge', '[{"after": "item", "field": "deleted", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (62, '2026-10-10 14:31:19.756776+00', 'owner', '01a12639-b02c-7650-bd6c-d9a11080e5f0', NULL, 'update', '[{"after": [{"on": "2026-10-10", "said_by": "01a12639-b00c-7a09-aebf-95d0f35d66e2"}], "field": "sources", "before": []}, {"after": "extracted", "field": "provenance.employer", "before": "inferred"}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (63, '2026-10-10 14:31:20.21556+00', 'owner', '01a12639-b02c-7650-bd6c-d9a11080e5f0', NULL, 'update', '[{"after": {"note": "meter reader", "entry": "01a12639-b01b-716a-b234-871f619160b1", "provenance": "extracted", "valid_from": "2022-05-01"}, "field": "links.works_at", "before": {"note": "meter reader", "entry": "01a12639-b01b-716a-b234-871f619160b1", "provenance": "inferred", "valid_from": "2022-05-01"}}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (64, '2026-10-10 14:31:21.202271+00', 'agent-garden', '01a12639-b043-7d5f-a8de-cc231ebc5208', NULL, 'update', '[{"after": [{"item": "01a12639-bd5e-7e4a-b460-714997fb09d1", "source": "inbox"}], "field": "sources", "before": []}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (65, '2026-10-10 14:31:21.218088+00', 'agent-garden', '01a12639-b043-7d5f-a8de-cc231ebc5208', NULL, 'attach', '[{"after": {"mime": "image/png", "size": 70, "sha256": "6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0"}, "field": "media.01a12639-bf80-76a7-b8e5-7830d774a54a", "before": null}]');
INSERT INTO public.events (id, at, actor, entry_id, type_name, action, changes) OVERRIDING SYSTEM VALUE VALUES (66, '2026-10-10 14:31:21.311818+00', 'agent-garden', '01a12639-bfde-7a38-bff9-edea7848d7a5', NULL, 'create', '[{"after": "note", "field": "type", "before": null}, {"after": "Shed door", "field": "title", "before": null}, {"after": "shed-door", "field": "slug", "before": null}, {"after": [], "field": "aliases", "before": null}, {"after": [], "field": "tags", "before": null}, {"after": "The hinges need oil.", "field": "body", "before": null}, {"after": "", "field": "summary", "before": null}, {"after": [{"item": "01a12639-bd73-748f-a980-0c82ecc844ee", "source": "inbox"}], "field": "sources", "before": null}, {"after": "extracted", "field": "provenance.body", "before": null}, {"after": {"entry": "01a12639-b031-7215-84ac-52d237c6cacc", "provenance": "extracted"}, "field": "links.part_of", "before": null}]');


--
-- Data for Name: finding_occurrences; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.finding_occurrences (id, finding, at, origin, title, severity, trying, happened, expected, steps, instance, version, commit, key_name, call_tool, call_arguments) OVERRIDING SYSTEM VALUE VALUES (1, 1, '2026-10-10 14:31:21.335398+00', 'agent', 'The parent of a moved entry is hard to find', 'cosmetic', 'Finding where the bike pump was before.', 'Its former place is only in part_of.', 'A word in the path.', '', 'local', '0.6.0', 'fixture', 'agent-garden', NULL, NULL);
INSERT INTO public.finding_occurrences (id, finding, at, origin, title, severity, trying, happened, expected, steps, instance, version, commit, key_name, call_tool, call_arguments) OVERRIDING SYSTEM VALUE VALUES (2, 1, '2026-10-10 14:31:21.351363+00', 'agent', 'The parent of a moved entry is hard to find', 'cosmetic', 'Finding where the old radio was.', 'Again only in part_of.', 'A word in the path.', '', 'local', '0.6.0', 'fixture', 'agent-kitchen', NULL, NULL);
INSERT INTO public.finding_occurrences (id, finding, at, origin, title, severity, trying, happened, expected, steps, instance, version, commit, key_name, call_tool, call_arguments) OVERRIDING SYSTEM VALUE VALUES (3, 1, '2026-10-10 14:31:21.36496+00', 'agent', 'Former places are not in the path', 'hurts', 'Reading the bike pump.', 'The garden shed is not named in the path.', 'The former place named.', '', 'local', '0.6.0', 'fixture', 'agent-garden', NULL, NULL);


--
-- Data for Name: findings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.findings (number, title, kind, place, severity, occurrences, first_seen, last_seen, merged_into) OVERRIDING SYSTEM VALUE VALUES (1, 'The parent of a moved entry is hard to find', 'model_friction', 'read', 'hurts', 3, '2026-10-10 14:31:21.334675+00', '2026-10-10 14:31:21.364658+00', NULL);
INSERT INTO public.findings (number, title, kind, place, severity, occurrences, first_seen, last_seen, merged_into) OVERRIDING SYSTEM VALUE VALUES (2, 'Former places are not in the path', 'model_friction', 'read', 'hurts', 0, '2026-10-10 14:31:21.364658+00', '2026-10-10 14:31:21.364658+00', 1);


--
-- Data for Name: heads_up; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.heads_up (actor, entry_id, field, period, day) VALUES ('agent-kitchen', '01a12639-b051-7511-b2f5-a1a4748e8e02', 'renewal', '2026', '2026-10-10');
INSERT INTO public.heads_up (actor, entry_id, field, period, day) VALUES ('agent-garden', '01a12639-b051-7511-b2f5-a1a4748e8e02', 'renewal', '2026', '2026-10-10');


--
-- Data for Name: inbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.inbox (id, kind, name, content, sha256, size, origin, received_at, status, taken_by, taken_at, closed_by, closed_at, reason, mime) VALUES ('01a12639-bd5e-7e4a-b460-714997fb09d1', 'file', 'receipt.png', NULL, '6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0', 70, 'scanner', '2026-10-10 14:31:20.661558+00', 'processed', 'agent-garden', '2026-10-10 14:31:21.134986+00', 'agent-garden', '2026-10-10 14:31:21.17813+00', NULL, 'image/png');
INSERT INTO public.inbox (id, kind, name, content, sha256, size, origin, received_at, status, taken_by, taken_at, closed_by, closed_at, reason, mime) VALUES ('01a12639-bf17-7742-9595-6a791c770e12', 'url', NULL, 'https://example.org/compost-guide', NULL, NULL, 'phone', '2026-10-10 14:31:21.111378+00', 'dismissed', 'agent-garden', '2026-10-10 14:31:21.231854+00', 'agent-garden', '2026-10-10 14:31:21.24652+00', 'already read', NULL);
INSERT INTO public.inbox (id, kind, name, content, sha256, size, origin, received_at, status, taken_by, taken_at, closed_by, closed_at, reason, mime) VALUES ('01a12639-beed-7a43-9ba7-0f39baec8880', 'text', NULL, 'Buy seeds for the herb spiral.', NULL, NULL, 'phone', '2026-10-10 14:31:21.069418+00', 'pending', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.inbox (id, kind, name, content, sha256, size, origin, received_at, status, taken_by, taken_at, closed_by, closed_at, reason, mime) VALUES ('01a12639-bd73-748f-a980-0c82ecc844ee', 'file', 'to-do.txt', 'Oil the hinges of the shed door.
', NULL, 33, 'scanner', '2026-10-10 14:31:20.689254+00', 'taken', 'agent-garden', '2026-10-10 14:31:21.289255+00', NULL, NULL, NULL, NULL);


--
-- Data for Name: instance_rules; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.instance_rules (id, rules, updated) VALUES (1, '# Rules

- Write titles in sentence case.
- Prices in euros.
', '2026-10-10 14:31:16.682147+00');


--
-- Data for Name: links; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b03f-70db-a094-f673ef16594b', '01a12639-b03a-7461-a501-e5a6c78c4831', 'part_of', '', '', NULL, NULL, NULL, 'extracted', 2);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b043-7d5f-a8de-cc231ebc5208', '01a12639-b031-7215-84ac-52d237c6cacc', 'part_of', '', '', NULL, NULL, NULL, 'inferred', 3);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b025-79c5-b6dc-28656f16ce89', '01a12639-b015-7e75-a3ff-a912f5c9cf68', 'mentions', '', '', NULL, NULL, NULL, NULL, 7);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b060-7aa1-949b-7adeeb9f3dda', '01a12639-b031-7215-84ac-52d237c6cacc', 'mentions', '', '', NULL, NULL, NULL, NULL, 10);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b060-7aa1-949b-7adeeb9f3dda', '01a12639-b043-7d5f-a8de-cc231ebc5208', 'mentions', '', '', NULL, NULL, NULL, NULL, 11);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b048-7aeb-b282-71ded986e13d', '01a12639-b031-7215-84ac-52d237c6cacc', 'part_of', '', '', NULL, NULL, '2026-10-09', 'inferred', 4);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b048-7aeb-b282-71ded986e13d', '01a12639-b035-724a-9b8f-69ab6e6dc44d', 'part_of', '', '', NULL, '2026-10-10', NULL, 'inferred', 12);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b025-79c5-b6dc-28656f16ce89', '01a12639-b015-7e75-a3ff-a912f5c9cf68', 'works_at', '', '', 'cashier', '2019-03-01', '2021-08-31', 'extracted', 13);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b025-79c5-b6dc-28656f16ce89', '01a12639-b02c-7650-bd6c-d9a11080e5f0', 'knows', '', '', NULL, NULL, NULL, 'inferred', 15);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b043-7d5f-a8de-cc231ebc5208', '01a12639-b015-7e75-a3ff-a912f5c9cf68', 'bought_from', '', '', 'spring sale', NULL, NULL, 'inferred', 16);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b04c-7f2d-a39d-650bb642288a', '01a12639-b031-7215-84ac-52d237c6cacc', 'part_of', '', '', NULL, '2018-01-01', '2020-12-31', 'inferred', 17);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b04c-7f2d-a39d-650bb642288a', '01a12639-b031-7215-84ac-52d237c6cacc', 'part_of', '2023-01-01', '', NULL, '2023-01-01', '2024-06-30', 'inferred', 18);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b1be-7292-9be9-62c16c184ab6', '01a12639-b051-7511-b2f5-a1a4748e8e02', 'fulfills', '2025', 'renewal', NULL, NULL, NULL, 'extracted', 20);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-b02c-7650-bd6c-d9a11080e5f0', '01a12639-b01b-716a-b234-871f619160b1', 'works_at', '', '', 'meter reader', '2022-05-01', NULL, 'extracted', 14);
INSERT INTO public.links (source_id, target_id, relation, period, field, note, valid_from, valid_until, provenance, seq) VALUES ('01a12639-bfde-7a38-bff9-edea7848d7a5', '01a12639-b031-7215-84ac-52d237c6cacc', 'part_of', '', '', NULL, NULL, NULL, 'extracted', 21);


--
-- Data for Name: media; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.media (id, entry_id, kind, mime, size, sha256, width, height, duration, source_url, alt, "position", created) VALUES ('01a12639-b1e5-7ddb-a161-06838ee06fda', '01a12639-b03a-7461-a501-e5a6c78c4831', 'image', 'image/png', 68, '63ef318d96b5d0d0ceba6e04a4e622b1158335cdc67c49e27839132c6f655058', 1, 1, NULL, NULL, 'Front of the case, with the new fan', 1, '2026-10-10 14:31:17.731892+00');
INSERT INTO public.media (id, entry_id, kind, mime, size, sha256, width, height, duration, source_url, alt, "position", created) VALUES ('01a12639-b202-7d3a-9295-ff5b176549f6', '01a12639-b060-7aa1-949b-7adeeb9f3dda', 'image', 'image/svg+xml', 111, 'a0b033249dfac33872fd0ee79092a054b856076d1d990dc936c6b807a1fe763b', 40, 20, NULL, NULL, 'Sketch of the beds', 1, '2026-10-10 14:31:17.762067+00');
INSERT INTO public.media (id, entry_id, kind, mime, size, sha256, width, height, duration, source_url, alt, "position", created) VALUES ('01a12639-bf80-76a7-b8e5-7830d774a54a', '01a12639-b043-7d5f-a8de-cc231ebc5208', 'image', 'image/png', 70, '6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0', 1, 1, NULL, NULL, 'Receipt of the mower', 1, '2026-10-10 14:31:21.17813+00');


--
-- Data for Name: pending_references; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_references (source_id, slug) VALUES ('01a12639-b060-7aa1-949b-7adeeb9f3dda', 'herb-spiral');


--
-- Data for Name: type_proposals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.type_proposals (id, action, type_name, into_type, mapping, proposed_by, proposed_at, status, decided_by, decided_at) VALUES ('01a12639-b624-7089-8d0d-1fc31f5f9d51', 'delete', 'draft', NULL, NULL, 'agent-kitchen', '2026-10-10 14:31:18.819998+00', 'pending', NULL, NULL);
INSERT INTO public.type_proposals (id, action, type_name, into_type, mapping, proposed_by, proposed_at, status, decided_by, decided_at) VALUES ('01a12639-b614-7ddf-bf3b-d4e26664dbf6', 'merge', 'gadget', 'item', '{"brand": "brand"}', 'agent-kitchen', '2026-10-10 14:31:18.804563+00', 'confirmed', 'owner', '2026-10-10 14:31:19.268258+00');


--
-- Data for Name: types; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('journal', 'Journal', 'A page of the private journal.', '[{"kind": "enum", "name": "mood", "values": ["calm", "busy", "tired"]}]', '2026-10-10 14:31:17.174548+00', '2026-10-10 14:31:17.174548+00', NULL, true, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('draft', 'Draft', 'A type no entry uses.', '[]', '2026-10-10 14:31:17.216402+00', '2026-10-10 14:31:17.216402+00', NULL, false, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('organization', 'Organization', 'A company, a shop, a library or any body the owner deals with.', '[{"kind": "url", "name": "website"}, {"kind": "text", "name": "city"}]', '2026-10-10 14:31:17.08934+00', '2026-10-10 14:31:17.776367+00', NULL, false, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('person', 'Person', 'Someone the owner knows.', '[{"kind": "text", "name": "email", "sensitive": true}, {"kind": "date", "name": "birthday", "recurs": {"every": "yearly", "notice": "P14D"}}, {"kind": "entry", "name": "employer", "types": ["organization"]}, {"kind": "text", "many": true, "name": "languages"}, {"kind": "text", "name": "nickname"}]', '2026-10-10 14:31:17.124989+00', '2026-10-10 14:31:17.790282+00', NULL, false, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('item', 'Item', 'A thing the owner keeps: a tool, a machine, a piece of furniture.', '[{"kind": "text", "name": "brand", "required": true}, {"kind": "text", "name": "serial", "sensitive": true}, {"kind": "money", "name": "price"}, {"kind": "date", "name": "bought_on"}, {"due": {"notice": "P30D"}, "kind": "date", "name": "warranty_until"}, {"kind": "entry", "many": true, "name": "sellers", "types": ["organization"]}, {"kind": "integer", "name": "power_w"}, {"kind": "number", "name": "weight_kg"}, {"kind": "boolean", "name": "portable"}, {"kind": "enum", "name": "condition", "values": ["new", "used", "worn", "broken"]}]', '2026-10-10 14:31:17.14122+00', '2026-10-10 14:31:17.821473+00', NULL, false, true);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('contract', 'Contract', 'A contract or a subscription followed over time.', '[{"kind": "entry", "name": "provider", "types": ["organization"], "required": true}, {"kind": "money", "name": "monthly_cost"}, {"kind": "date", "name": "renewal", "recurs": {"every": "yearly", "notice": "P30D"}}, {"kind": "duration", "name": "notice_period"}, {"kind": "datetime", "name": "signed_at"}, {"kind": "text", "name": "account_number"}]', '2026-10-10 14:31:17.158017+00', '2026-10-10 14:31:18.298549+00', NULL, false, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('note', 'Note', 'A free note, or a place things are kept in.', '[]', '2026-10-10 14:31:17.188846+00', '2026-10-10 14:31:18.766945+00', NULL, false, false);
INSERT INTO public.types (name, label, description, fields, created, updated, deleted_at, sensitive, read_in_parent) VALUES ('gadget', 'Gadget', 'A small device; to be merged into items.', '[{"kind": "text", "name": "brand"}]', '2026-10-10 14:31:17.202999+00', '2026-10-10 14:31:17.202999+00', '2026-10-10 14:31:19.268258+00', false, false);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 20, true);


--
-- Name: events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.events_id_seq', 66, true);


--
-- Name: finding_occurrences_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.finding_occurrences_id_seq', 3, true);


--
-- Name: findings_number_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.findings_number_seq', 2, true);


--
-- Name: links_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.links_seq_seq', 21, true);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_apikey auth_apikey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_apikey
    ADD CONSTRAINT auth_apikey_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_token_key UNIQUE (token);


--
-- Name: auth_user auth_user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_email_key UNIQUE (email);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: entries entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_pkey PRIMARY KEY (id);


--
-- Name: entries entries_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_slug_key UNIQUE (slug);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: finding_occurrences finding_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_pkey PRIMARY KEY (id);


--
-- Name: findings findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_pkey PRIMARY KEY (number);


--
-- Name: heads_up heads_up_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heads_up
    ADD CONSTRAINT heads_up_pkey PRIMARY KEY (actor, entry_id, field, period, day);


--
-- Name: inbox inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox
    ADD CONSTRAINT inbox_pkey PRIMARY KEY (id);


--
-- Name: instance_rules instance_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_rules
    ADD CONSTRAINT instance_rules_pkey PRIMARY KEY (id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (source_id, target_id, relation, period, field);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);


--
-- Name: pending_references pending_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_references
    ADD CONSTRAINT pending_references_pkey PRIMARY KEY (source_id, slug);


--
-- Name: type_proposals type_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.type_proposals
    ADD CONSTRAINT type_proposals_pkey PRIMARY KEY (id);


--
-- Name: types types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.types
    ADD CONSTRAINT types_pkey PRIMARY KEY (name);


--
-- Name: auth_apikey_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_apikey_key ON public.auth_apikey USING btree (key);


--
-- Name: auth_session_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user ON public.auth_session USING btree ("userId");


--
-- Name: entries_aliases; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_aliases ON public.entries USING gin (aliases);


--
-- Name: entries_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_search ON public.entries USING gin ((((search || setweight(jsonb_to_tsvector(search_language, fields, '["string", "numeric"]'::jsonb), 'C'::"char")) || setweight(jsonb_to_tsvector(search_language, ((jsonb_path_query_array(sources, '$[*]."url"'::jsonpath) || jsonb_path_query_array(sources, '$[*]."identifier"'::jsonpath)) || jsonb_path_query_array(sources, '$[*]."label"'::jsonpath)), '["string"]'::jsonb), 'C'::"char"))));


--
-- Name: entries_sources; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_sources ON public.entries USING gin (sources jsonb_path_ops);


--
-- Name: entries_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entries_type ON public.entries USING btree (type);


--
-- Name: events_entry_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_entry_id ON public.events USING btree (entry_id);


--
-- Name: events_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_type_name ON public.events USING btree (type_name);


--
-- Name: finding_occurrences_finding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finding_occurrences_finding ON public.finding_occurrences USING btree (finding, at);


--
-- Name: findings_kind_place; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX findings_kind_place ON public.findings USING btree (kind, place);


--
-- Name: inbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_status ON public.inbox USING btree (status, received_at);


--
-- Name: links_part_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_part_of ON public.links USING btree (target_id, source_id) WHERE (relation = 'part_of'::text);


--
-- Name: links_target_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_target_id ON public.links USING btree (target_id);


--
-- Name: media_entry_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_entry_id ON public.media USING btree (entry_id);


--
-- Name: media_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_sha256 ON public.media USING btree (sha256);


--
-- Name: pending_references_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_references_slug ON public.pending_references USING btree (slug);


--
-- Name: auth_account auth_account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_apikey auth_apikey_referenceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_apikey
    ADD CONSTRAINT "auth_apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: entries entries_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.entries(id);


--
-- Name: entries entries_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entries
    ADD CONSTRAINT entries_type_fkey FOREIGN KEY (type) REFERENCES public.types(name);


--
-- Name: events events_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.entries(id);


--
-- Name: events events_type_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_type_name_fkey FOREIGN KEY (type_name) REFERENCES public.types(name);


--
-- Name: finding_occurrences finding_occurrences_finding_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_finding_fkey FOREIGN KEY (finding) REFERENCES public.findings(number);


--
-- Name: findings findings_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.findings(number);


--
-- Name: heads_up heads_up_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heads_up
    ADD CONSTRAINT heads_up_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.entries(id);


--
-- Name: links links_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.entries(id);


--
-- Name: links links_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.entries(id);


--
-- Name: media media_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.entries(id);


--
-- Name: pending_references pending_references_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_references
    ADD CONSTRAINT pending_references_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.entries(id);


--
-- Name: type_proposals type_proposals_into_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.type_proposals
    ADD CONSTRAINT type_proposals_into_type_fkey FOREIGN KEY (into_type) REFERENCES public.types(name);


--
-- Name: type_proposals type_proposals_type_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.type_proposals
    ADD CONSTRAINT type_proposals_type_name_fkey FOREIGN KEY (type_name) REFERENCES public.types(name);


--
-- PostgreSQL database dump complete
--


