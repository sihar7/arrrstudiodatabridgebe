CREATE TABLE "migration_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"destination_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"checksum" text,
	"size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_id" uuid NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_config_id" uuid NOT NULL,
	"destination_config_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mode" text DEFAULT 'full' NOT NULL,
	"selected_keys" jsonb,
	"prefix" text,
	"conflict_strategy" text DEFAULT 'skip_existing' NOT NULL,
	"rename_pattern" text,
	"verify" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"enum_cursor" text,
	"enum_done" boolean DEFAULT false NOT NULL,
	"total_keys" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"bytes_read" bigint DEFAULT 0 NOT NULL,
	"current_operation" text,
	"run_token" text,
	"last_error" text,
	"last_dry_run_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"roblox_user_id" text NOT NULL,
	"roblox_username" text NOT NULL,
	"roblox_display_name" text,
	"roblox_avatar_url" text,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roblox_connections" ALTER COLUMN "encrypted_api_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "roblox_connections" ADD COLUMN "auth_type" text DEFAULT 'api_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "roblox_connections" ADD COLUMN "encrypted_refresh_token" text;--> statement-breakpoint
ALTER TABLE "roblox_connections" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "roblox_connections" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roblox_connections" ADD COLUMN "roblox_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roblox_avatar_url" text;--> statement-breakpoint
ALTER TABLE "migration_items" ADD CONSTRAINT "migration_items_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_logs" ADD CONSTRAINT "migration_logs_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_source_config_id_datastore_configs_id_fk" FOREIGN KEY ("source_config_id") REFERENCES "public"."datastore_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_destination_config_id_datastore_configs_id_fk" FOREIGN KEY ("destination_config_id") REFERENCES "public"."datastore_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_items_unique" ON "migration_items" USING btree ("migration_id","source_key");--> statement-breakpoint
CREATE INDEX "migration_items_status_idx" ON "migration_items" USING btree ("migration_id","status");--> statement-breakpoint
CREATE INDEX "migration_logs_idx" ON "migration_logs" USING btree ("migration_id","created_at");--> statement-breakpoint
CREATE INDEX "migrations_ws_idx" ON "migrations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "migrations_status_idx" ON "migrations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_unique" ON "workspace_invites" USING btree ("workspace_id","roblox_user_id");--> statement-breakpoint
CREATE INDEX "workspace_invites_roblox_idx" ON "workspace_invites" USING btree ("roblox_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_roblox_user_id_unique" UNIQUE("roblox_user_id");