package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"
)

var errMalwareDetected = errors.New("malware detected")

func scanWithClamAV(ctx context.Context, path string) (string, error) {
	address := os.Getenv("CLAMAV_ADDRESS")
	if address == "" {
		if os.Getenv("APP_ENV") != "production" && os.Getenv("ALLOW_UNSCANNED_LOCAL") == "true" {
			return "SKIPPED", nil
		}
		return "", errors.New("CLAMAV_ADDRESS is required outside explicit local development mode")
	}

	dialer := net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return "", fmt.Errorf("connect to ClamAV: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}

	if _, err := connection.Write([]byte("zINSTREAM\x00")); err != nil {
		return "", fmt.Errorf("start ClamAV stream: %w", err)
	}
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open scan file: %w", err)
	}
	defer file.Close()

	buffer := make([]byte, 1024*1024)
	length := make([]byte, 4)
	for {
		read, readErr := file.Read(buffer)
		if read > 0 {
			binary.BigEndian.PutUint32(length, uint32(read))
			if _, err := connection.Write(length); err != nil {
				return "", fmt.Errorf("send ClamAV chunk length: %w", err)
			}
			if _, err := connection.Write(buffer[:read]); err != nil {
				return "", fmt.Errorf("send ClamAV chunk: %w", err)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return "", fmt.Errorf("read scan file: %w", readErr)
			}
			break
		}
	}

	if _, err := connection.Write([]byte{0, 0, 0, 0}); err != nil {
		return "", fmt.Errorf("finish ClamAV stream: %w", err)
	}
	response, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read ClamAV result: %w", err)
	}
	response = strings.TrimSpace(response)
	if strings.HasSuffix(response, "OK") {
		return "CLEAN", nil
	}
	if strings.Contains(response, "FOUND") {
		return "INFECTED", errMalwareDetected
	}
	return "", fmt.Errorf("unexpected ClamAV response: %s", response)
}
