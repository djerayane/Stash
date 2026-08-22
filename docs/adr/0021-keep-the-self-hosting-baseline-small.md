# Keep the self-hosting baseline small

The supported baseline is one Stash application container plus PostgreSQL, with local Attachment storage by default and optional S3-compatible storage. PostgreSQL supports durable jobs, search, and synchronization state by default; a queue and cache abstraction may use Redis as an optional acceleration profile, but Redis cannot be required for correctness or features. Docker Compose, health checks, and documented backup procedures define the standard operator experience.
