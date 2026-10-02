CREATE TABLE "legal_corpus_version" (
	"layer" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"corpus_id" text NOT NULL,
	"version" text NOT NULL,
	"hash" text NOT NULL,
	"state" text NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "legal_corpus_version_corpus_id_version_hash_pk" PRIMARY KEY("corpus_id","version","hash"),
	CONSTRAINT "legal_corpus_version_layer_chk" CHECK ("legal_corpus_version"."layer" in ('L1','L2','L3','L4','L5','L6')),
	CONSTRAINT "legal_corpus_version_state_chk" CHECK ("legal_corpus_version"."state" in ('shadow','canary','active','retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legal_corpus_version_active_uq" ON "legal_corpus_version" USING btree ("jurisdiction","corpus_id") WHERE "legal_corpus_version"."state" = 'active';