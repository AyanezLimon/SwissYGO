-- #108 deck stats: snapshot the registered deck's parsed card codes onto the
-- registration. /join already parses the deck for #109 legality, so storing the
-- result here means stats aggregation needs NO external API call and survives the
-- deck being deleted later. JSON: {"main":[...],"extra":[...],"side":[...]}.
ALTER TABLE registrations ADD COLUMN cards_json TEXT;
