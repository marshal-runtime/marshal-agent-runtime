# Queue fixture

`runQueuedJob` passes its cancellation signal through `waitForWork` to the queued worker record. The focused defect is that `waitForWork` leaves its abort listener registered after either resolution or rejection.
