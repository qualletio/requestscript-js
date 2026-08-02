ALTER TABLE "contracts" ALTER COLUMN "version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "contracts" ALTER COLUMN "version" SET DATA TYPE text USING "version"::text;--> statement-breakpoint
ALTER TABLE "contracts" ALTER COLUMN "version" SET DEFAULT '1';
