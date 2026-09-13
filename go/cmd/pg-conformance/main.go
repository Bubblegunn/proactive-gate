// Command pg-conformance runs the proactive-gate fixture suite against an
// implementation and reports pass, fail or skip per fixture, in the shape
// spec/CONFORMANCE.md describes.
//
//	pg-conformance                      run the suite against the Go gate
//	pg-conformance -stub                run it against a stub that fails all
//	pg-conformance -json                print {"ran":N,"failures":[...]}
//
// The exit code is non-zero when any fixture fails.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/Bubblegunn/proactive-gate/go/conformance"
	gate "github.com/Bubblegunn/proactive-gate/go/proactivegate"
)

func main() {
	var (
		fixturesDir = flag.String("fixtures", defaultPath("spec", "fixtures"), "directory holding the fixture JSON files")
		skipsFile   = flag.String("skips", defaultPath("spec", "skip", "go.txt"), "skip file: one fixture name per line, reason after #")
		stub        = flag.Bool("stub", false, "run against a stub target that fails every fixture")
		asJSON      = flag.Bool("json", false, "print the machine-readable summary used by scripts/conformance-table.mjs")
	)
	flag.Parse()

	fixtures, err := conformance.LoadFixtures(*fixturesDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pg-conformance: fixtures: %s\n", err)
		os.Exit(2)
	}
	skips, err := conformance.ReadSkips(*skipsFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pg-conformance: skips: %s\n", err)
		os.Exit(2)
	}

	var target conformance.Target = gate.ConformanceTarget{}
	if *stub {
		target = conformance.Stub{}
	}
	report := conformance.Run(fixtures, skips, target)

	if *asJSON {
		var failures []string
		for _, r := range report.Results {
			failures = append(failures, r.Failures...)
		}
		if failures == nil {
			failures = []string{}
		}
		out, _ := json.Marshal(map[string]any{"ran": report.Passed + report.Failed, "failures": failures})
		fmt.Println(string(out))
	} else {
		fmt.Print(report.Text())
	}
	if report.Failed > 0 {
		os.Exit(1)
	}
}

// defaultPath resolves a repo-relative path from this command's source
// directory, so the suite runs the same from anywhere in the module.
func defaultPath(elem ...string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return filepath.Join(elem...)
	}
	// this file lives at go/cmd/pg-conformance/main.go; the repo root is three up
	return filepath.Join(append([]string{filepath.Dir(file), "..", "..", ".."}, elem...)...)
}
