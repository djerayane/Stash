# Treat Note removal as a branch operation

Archiving or moving a parent Note to recoverable trash acts on its complete contained branch, with confirmation that previews descendants, owned Collections, inherited Project access, and externally linked Notes. Restoration recovers the branch together whenever possible, while permanent deletion continues to follow ADR-0009 and must address Collection ownership rather than silently orphaning or deleting structured data.
