package proactivegate

import "time"

// isValidZone reports whether name is an IANA zone the runtime loads. The
// empty string and "Local" (the machine's own zone, not a fixed name) are not.
func isValidZone(name string) bool {
	if name == "" || name == "Local" {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

// effectiveZone is the zone a user's local time is read in (SPEC 9.2): the
// device zone when it is valid, else the profile zone when it is valid, else
// "" for none. An invalid device zone is ignored as if it were absent.
func effectiveZone(user *UserState) string {
	if isValidZone(user.DeviceTimezone) {
		return user.DeviceTimezone
	}
	if isValidZone(user.Timezone) {
		return user.Timezone
	}
	return ""
}

// reportedZone is the zone quiet hours need under onMissingTimezone "reject"
// (SPEC 9.2.1). The placeholder "UTC" is no zone unless a valid device zone is
// present, so a profile that was never given a zone is rejected, not read as UTC.
func reportedZone(user *UserState) string {
	if isValidZone(user.DeviceTimezone) {
		return user.DeviceTimezone
	}
	if isValidZone(user.Timezone) && user.Timezone != "UTC" {
		return user.Timezone
	}
	return ""
}

// isCommitment reports whether the person set the candidate up, such as a
// reminder they asked for (SPEC 9.4).
func isCommitment(c *Candidate) bool { return c.Kind == "commitment" }

// notPromotional names why a candidate is not promotion, or "" when it may be
// promotion (SPEC 9.7). The reason is the word the pass reports.
func notPromotional(c *Candidate) string {
	switch {
	case c.Transactional:
		return "transactional"
	case c.Requested:
		return "requested"
	case isCommitment(c):
		return "commitment"
	}
	return ""
}
