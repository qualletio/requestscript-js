-- RequestScript 2.0 (SIP-1) moved parameters onto functions, so contracts saved in the old syntax no longer parse.
DELETE FROM "contracts";--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "functions" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" DROP COLUMN "parameters";