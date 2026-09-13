package conformance_test

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Bubblegunn/proactive-gate/go/conformance"
	gate "github.com/Bubblegunn/proactive-gate/go/proactivegate"
)

// repoRoot resolves the repository root from this file, which lives at
// go/conformance/suite_test.go.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}

// The spec version this module claims must equal the vendored SPEC_VERSION;
// otherwise the suite moved and the claim did not.
func TestSpecVersion(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "spec", "SPEC_VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != gate.SpecVersion {
		t.Fatalf("declared spec version %s, vendored suite is %s", gate.SpecVersion, got)
	}
}

// Every fixture not listed in spec/skip/go.txt must pass.
func TestFixtures(t *testing.T) {
	root := repoRoot(t)
	fixtures, err := conformance.LoadFixtures(filepath.Join(root, "spec", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	skips, err := conformance.ReadSkips(filepath.Join(root, "spec", "skip", "go.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		f := f
		t.Run(f.Name, func(t *testing.T) {
			if reason, ok := skips[f.Name]; ok {
				t.Skipf("declared skip: %s", reason)
			}
			for _, failure := range conformance.RunFixture(f, gate.ConformanceTarget{}) {
				t.Error(failure)
			}
		})
	}
}

// The runner must say so precisely when the implementation fails everything:
// pointed at the stub, every fixture fails and none pass or are skipped.
func TestStubFailsEverything(t *testing.T) {
	root := repoRoot(t)
	fixtures, err := conformance.LoadFixtures(filepath.Join(root, "spec", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	report := conformance.Run(fixtures, nil, conformance.Stub{})
	if report.Passed != 0 || report.Skipped != 0 {
		t.Fatalf("stub run: %d passed, %d skipped; expected all %d to fail", report.Passed, report.Skipped, len(fixtures))
	}
	if report.Failed != len(fixtures) {
		t.Fatalf("stub run: %d of %d failed", report.Failed, len(fixtures))
	}
	for _, r := range report.Results {
		if len(r.Failures) == 0 {
			t.Errorf("%s: stub failure carried no mismatch detail", r.Name)
		}
	}
}
