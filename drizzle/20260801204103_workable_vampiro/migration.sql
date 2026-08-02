DROP INDEX "contracts_path_name_unique";--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_path_name_version_unique" ON "contracts" USING btree ("path","name","version");--> statement-breakpoint
ALTER TABLE "contracts" DROP COLUMN "updated_at";