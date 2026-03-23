-- Migration 029: Create Murekefu community chat tables and user chat settings.

CREATE TABLE IF NOT EXISTS public.community_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.community_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.community_rooms(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  message TEXT,
  attachment_url TEXT,
  attachment_name VARCHAR(255),
  attachment_kind VARCHAR(24) NOT NULL DEFAULT 'text',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT community_messages_content_check CHECK (
    COALESCE(NULLIF(BTRIM(message), ''), NULL) IS NOT NULL
    OR COALESCE(NULLIF(BTRIM(attachment_url), ''), NULL) IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS public.community_user_settings (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  bubble_tone VARCHAR(24) NOT NULL DEFAULT 'theme',
  density VARCHAR(24) NOT NULL DEFAULT 'comfortable',
  wallpaper VARCHAR(24) NOT NULL DEFAULT 'aurora',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_rooms_public
  ON public.community_rooms(is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_messages_room_created
  ON public.community_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_messages_sender
  ON public.community_messages(sender_user_id, created_at DESC);

ALTER TABLE public.community_rooms DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_user_settings DISABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_community_rooms_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_community_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_community_user_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS community_rooms_updated_at_trigger ON public.community_rooms;
CREATE TRIGGER community_rooms_updated_at_trigger
BEFORE UPDATE ON public.community_rooms
FOR EACH ROW
EXECUTE FUNCTION public.update_community_rooms_updated_at();

DROP TRIGGER IF EXISTS community_messages_updated_at_trigger ON public.community_messages;
CREATE TRIGGER community_messages_updated_at_trigger
BEFORE UPDATE ON public.community_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_community_messages_updated_at();

DROP TRIGGER IF EXISTS community_user_settings_updated_at_trigger ON public.community_user_settings;
CREATE TRIGGER community_user_settings_updated_at_trigger
BEFORE UPDATE ON public.community_user_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_community_user_settings_updated_at();

INSERT INTO public.community_rooms (slug, name, description, is_public)
SELECT
  'murekefu-community',
  'Murekefu Community',
  'A shared lounge for learners, composers, buyers, and the Murekefu team.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.community_rooms WHERE slug = 'murekefu-community'
);

COMMENT ON TABLE public.community_rooms IS 'Public and private community spaces for authenticated Murekefu members.';
COMMENT ON TABLE public.community_messages IS 'Messages shared inside Murekefu community rooms.';
COMMENT ON TABLE public.community_user_settings IS 'Per-user chat appearance settings for the messenger community experience.';
