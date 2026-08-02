CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_path_name_unique" ON "contracts" USING btree ("path","name");