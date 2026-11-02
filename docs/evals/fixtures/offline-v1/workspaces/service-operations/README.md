# Service operations fixture

Associate each failure with the newest deployment for the same service whose timestamp is not later than the failure. The revised run excludes cancelled deployments before doing that lookup. Ownership is an exact service-to-package mapping in `ownership.json`.
