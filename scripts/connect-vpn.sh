#!/bin/bash
# Connect KL Dugar Cisco IPSec VPN (must be configured in macOS as "kl dugar")
scutil --nc start "kl dugar"
sleep 2
scutil --nc status "kl dugar"
