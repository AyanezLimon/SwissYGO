-- #109: ranked tournaments require a registered, legal deck. Link each registration
-- to the saved deck the player chose — the player -> deck -> tournament link that the
-- standings deck art (#107) and deck stats (#108) consume. ON DELETE SET NULL so a
-- deleted deck doesn't drop the registration.
ALTER TABLE registrations ADD COLUMN deck_id INTEGER REFERENCES user_decks(id) ON DELETE SET NULL;
