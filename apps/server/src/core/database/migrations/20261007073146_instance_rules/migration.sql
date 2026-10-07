CREATE TABLE "instance_rules" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"rules" text NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_rules_one" CHECK (id = 1)
);
