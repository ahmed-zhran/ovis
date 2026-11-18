### Fixed
- A shared setting taken back while its save is on its way is no longer lost when the page closes
  before the answer, or when the save's answer is lost on the network after the server stored it.
- A setting saved on the way out of a hidden page is no longer sent a third time over a newer save
  from another browser, and a new change waits its own moment to be sent instead of the one of a
  change taken back.
