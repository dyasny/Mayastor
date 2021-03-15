{ crossSystem ? null
, pkgs-src ? (builtins.fetchGit {
    url = "https://github.com/NixOS/nixpkgs/";
    ref = "master";
    rev = "e5deabe68b7f85467d2f8519efe1daabbd9a86b5";
  })
}:

let
  pkgs = import (pkgs-src) {
    overlays = [
      (import ./nix/mayastor-overlay.nix)
    ];
    inherit crossSystem;
  };
in
pkgs
