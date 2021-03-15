{ stdenv
, clang
, dockerTools
, e2fsprogs
, lib
, libaio
, libiscsi
, libspdk
, libspdk-dev
, libudev
, liburing
, llvmPackages
, rustPlatform
, numactl
, openssl
, pkg-config
, protobuf
, xfsprogs
, util-linux
, llvmPackages_11
, targetPackages
, buildPackages
, targetPlatform
, version
, rustfmt
, cargoBuildFlags ? [ ]
}:
let
  whitelistSource = src: allowedPrefixes:
    builtins.filterSource
      (path: type:
        lib.any
          (allowedPrefix:
            lib.hasPrefix (toString (src + "/${allowedPrefix}")) path)
          allowedPrefixes)
      src;
  src_list = [
    "Cargo.lock"
    "Cargo.toml"
    "cli"
    "csi"
    "devinfo"
    "jsonrpc"
    "mayastor"
    "nvmeadm"
    "rpc"
    "spdk-sys"
    "sysfs"
    "mbus-api"
    "composer"
  ];
  buildProps = rec {
    name = "mayastor";
    #cargoSha256 = "0000000000000000000000000000000000000000000000000000";
    cargoSha256 = "jjg3nRMzSDtpy/xzm9GYa9yYQFZl5BEeheRtVe+rkqo=";
    inherit version cargoBuildFlags;
    src = whitelistSource ../../../. src_list;
    LIBCLANG_PATH = "${llvmPackages.libclang}/lib";
    PROTOC = "${protobuf}/bin/protoc";
    PROTOC_INCLUDE = "${protobuf}/include";

    # Backtrace on build error.
    RUST_BACKTRACE = "full";

    nativeBuildInputs = [
      pkg-config
      rustfmt
    ];
    buildInputs = [
      llvmPackages_11.libclang
      protobuf
      libaio
      libiscsi
      libudev
      liburing
      numactl
      openssl
      util-linux.dev
    ];
    verifyCargoDeps = false;
    doCheck = false;
    meta = { platforms = lib.platforms.linux; };
  };
in
{
  release = rustPlatform.buildRustPackage
    (buildProps // {
      buildType = "release";
      buildInputs = buildProps.buildInputs ++ [ libspdk ];
      SPDK_PATH = "${libspdk}";
    });
  debug = rustPlatform.buildRustPackage
    (buildProps // {
      buildType = "debug";
      buildInputs = buildProps.buildInputs ++ [ libspdk-dev ];
      SPDK_PATH = "${libspdk-dev}";
    });
  # this is for an image that does not do a build of mayastor
  adhoc = stdenv.mkDerivation {
    name = "mayastor-adhoc";
    inherit version;
    src = [
      ../../../target/debug/mayastor
      ../../../target/debug/mayastor-csi
      ../../../target/debug/mayastor-client
      ../../../target/debug/jsonrpc
    ];

    buildInputs = [
      libaio
      libiscsi
      libspdk-dev
      liburing
      libudev
      openssl
      xfsprogs
      e2fsprogs
    ];

    unpackPhase = ''
      for srcFile in $src; do
         cp $srcFile $(stripHash $srcFile)
      done
    '';
    dontBuild = true;
    dontConfigure = true;
    installPhase = ''
      mkdir -p $out/bin
      install * $out/bin
    '';
  };
}
